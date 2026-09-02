"""Ontology v3 loader — merges taxonomy, curated meta, and knowledge cards.

Three sources, all in this package directory:
- ``labels_v3.json``    taxonomy content (12 top intents x 56 sub-intents),
  authoritative for *what the intents are*; synced from repo-root labels_v3.json.
- ``meta_v3.yaml``      curated meta layer: A/B intent types, scopes, bipolar
  axes, value sets, confusable rules — *how the system uses* the taxonomy.
- ``knowledge_v3.yaml`` one film-grammar knowledge card per sub-intent: the
  reasoning anchor that replaces the exemplar library (pure-reasoning design).

Validated and merged at load time into a single read-only :class:`Ontology`.
"""

from __future__ import annotations

import json
import logging
from functools import lru_cache
from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, model_validator

logger = logging.getLogger(__name__)

#: The ten shot parameters (ADR-0006) — knowledge card technique keys must
#: be a subset of these.
TEN_PARAMS = (
    "shot_size",
    "composition",
    "angle",
    "movement",
    "focal_length",
    "depth_of_field",
    "lighting",
    "color_tone",
    "rhythm",
    "duration",
)

IntentType = Literal["A", "B"]
Scope = Literal["shot", "scene", "sequence", "both"]


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------


class KnowledgeCard(BaseModel):
    """Film-grammar knowledge attached to one sub-intent."""

    mechanism: str
    techniques: dict[str, str] = {}
    references: list[str] = []

    @model_validator(mode="after")
    def _validate_technique_keys(self) -> KnowledgeCard:
        unknown = set(self.techniques) - set(TEN_PARAMS)
        if unknown:
            raise ValueError(f"Knowledge card uses unknown shot parameters: {unknown}")
        return self


class SubIntent(BaseModel):
    """A second-level intent (leaf of the design space)."""

    code: str  # e.g. "8.3"
    name: str
    definition: str
    note: str = ""
    intent_type: IntentType  # A=导演构成性 / B=观众效应性
    scope: Scope = "shot"
    value_set: list[str] | None = None  # 维度·值结构(5.x):选中后需追问取值
    open_value: bool = False  # 5.4:开放取值(自由文本)
    axis_id: str | None = None  # 双极轴成员(6.1/6.2, 10.2/10.3, 11.1/11.2)
    knowledge: KnowledgeCard | None = None


class TopIntent(BaseModel):
    """A first-level intent (dimension of the design space)."""

    code: str  # "1".."12"
    name: str
    type_label: str  # raw label from labels_v3.json, e.g. "A/B(8.1=A;8.2-8.4=B)"
    definition: str
    selection: Literal["single", "multi"] = "multi"
    selection_hint: str = ""
    sub_intents: list[SubIntent]


class Axis(BaseModel):
    """A bipolar axis: two mutually exclusive sub-intents rendered as a slider."""

    id: str
    poles: tuple[str, str]
    description: str


class ConfusableRule(BaseModel):
    """A discrimination rule between easily-confused intents.

    Doubles as an alignment probe (question to the user) and a critic check.
    ``between`` holds two groups of code prefixes ("1" matches 1.x).
    """

    id: str
    between: list[list[str]]
    rule: str
    probe: str

    def involves(self, code: str) -> bool:
        return any(
            code == p or code.startswith(p + ".") for group in self.between for p in group
        )


class Ontology(BaseModel):
    """The merged, validated design space — single source for all nodes."""

    version: str = "v3"
    top_intents: list[TopIntent]
    axes: list[Axis] = []
    confusable_rules: list[ConfusableRule] = []

    # -- lookups -----------------------------------------------------------

    def get_top(self, name_or_code: str) -> TopIntent | None:
        for top in self.top_intents:
            if top.name == name_or_code or top.code == name_or_code:
                return top
        return None

    def get_sub(self, code: str) -> SubIntent | None:
        for top in self.top_intents:
            for sub in top.sub_intents:
                if sub.code == code:
                    return sub
        return None

    def all_codes(self) -> list[str]:
        return [s.code for t in self.top_intents for s in t.sub_intents]

    def validate_tags(self, tags: list[str]) -> tuple[list[str], list[str]]:
        """Split tags into (valid sub-intent codes, rejected entries)."""
        known = set(self.all_codes())
        valid = [t for t in tags if t in known]
        rejected = [t for t in tags if t not in known]
        return valid, rejected

    def rules_for(self, codes: list[str]) -> list[ConfusableRule]:
        """Confusable rules touching any of the given sub-intent codes."""
        return [r for r in self.confusable_rules if any(r.involves(c) for c in codes)]

    def axes_for(self, codes: list[str]) -> list[Axis]:
        code_set = set(codes)
        return [a for a in self.axes if code_set & set(a.poles)]

    # -- prompt digests ------------------------------------------------------
    # Compact text views injected into prompts; never dump raw model JSON.

    def alignment_digest(self) -> str:
        """Full design space as compact text — for align/convergence prompts."""
        lines: list[str] = []
        for top in self.top_intents:
            lines.append(
                f"{top.code}. {top.name}[{top.type_label}] — {top.definition}"
                + (f"(select:{top.selection}; hint: {top.selection_hint})" if top.selection_hint else "")
            )
            for sub in top.sub_intents:
                marks: list[str] = []
                if sub.axis_id:
                    marks.append(f"bipolar axis:{sub.axis_id}")
                if sub.value_set:
                    marks.append(f"value set:{'/'.join(sub.value_set)}")
                if sub.open_value:
                    marks.append("value set: open (must ask)")
                if sub.scope != "shot":
                    marks.append(f"scope:{sub.scope}")
                suffix = f" [{';'.join(marks)}]" if marks else ""
                lines.append(f"  {sub.code} {sub.name} — {sub.definition}{suffix}")
        lines.append("")
        lines.append("## Confusable discrimination rules (ask the user via the probe during alignment)")
        for r in self.confusable_rules:
            lines.append(f"- [{r.id}] {r.rule}  probe: {r.probe}")
        return "\n".join(lines)

    def knowledge_digest(self, codes: list[str]) -> str:
        """Knowledge cards for the given sub-intent codes — for generation."""
        blocks: list[str] = []
        for code in codes:
            sub = self.get_sub(code)
            if sub is None or sub.knowledge is None:
                continue
            card = sub.knowledge
            lines = [f"### {code} {sub.name} ({'Effect intent' if sub.intent_type == 'B' else 'Means intent'})"]
            lines.append(f"mechanism: {card.mechanism}")
            for param, guidance in card.techniques.items():
                lines.append(f"- {param}: {guidance}")
            if card.references:
                lines.append(f"references: {'; '.join(card.references)}")
            blocks.append("\n".join(lines))
        return "\n\n".join(blocks)

    def critic_digest(self, codes: list[str]) -> str:
        """Constraints relevant to the given codes — for critic prompts."""
        lines: list[str] = []
        rules = self.rules_for(codes)
        if rules:
            lines.append("## Confusable-misuse check")
            for r in rules:
                lines.append(f"- [{r.id}] {r.rule}")
        axes = self.axes_for(codes)
        if axes:
            lines.append("## Bipolar-axis consistency check (the two poles are mutually exclusive; one shot must not serve both)")
            for a in axes:
                lines.append(f"- {a.id}: {a.poles[0]} <-> {a.poles[1]} ({a.description})")
        return "\n".join(lines)


# ---------------------------------------------------------------------------
# Loading & merging
# ---------------------------------------------------------------------------


def _merge(labels: dict, meta: dict, knowledge: dict) -> Ontology:
    meta = meta["meta"]
    cards = {code: KnowledgeCard.model_validate(c) for code, c in knowledge["knowledge"].items()}

    sub_types: dict[str, str] = meta.get("sub_types", {})
    scope_of: dict[str, Scope] = {}
    for scope, codes in meta.get("scopes", {}).items():
        for code in codes:
            scope_of[code] = scope
    axis_of: dict[str, str] = {}
    axes = [Axis.model_validate(a) for a in meta.get("axes", [])]
    for axis in axes:
        for pole in axis.poles:
            axis_of[pole] = axis.id
    value_sets: dict[str, list[str]] = meta.get("value_sets", {})
    open_values: set[str] = set(meta.get("open_value", []))
    top_meta: dict[str, dict] = meta.get("top_intents", {})

    tops: list[TopIntent] = []
    for raw_top in labels["top_intents"]:
        name = raw_top["top_intent"]
        type_label = raw_top["type"]
        subs_raw = raw_top["sub_intents"]
        top_code = subs_raw[0]["code"].split(".")[0]
        # 一级 type 是 A 或 B 时直接继承;混合标注(如 8)靠 sub_types 覆盖
        default_type = type_label if type_label in ("A", "B") else None

        subs: list[SubIntent] = []
        for raw in subs_raw:
            code = raw["code"]
            intent_type = sub_types.get(code, default_type)
            if intent_type is None:
                raise ValueError(
                    f"Sub-intent {code}: top intent '{name}' has mixed type "
                    f"'{type_label}' but meta_v3.yaml sub_types has no entry"
                )
            subs.append(
                SubIntent(
                    code=code,
                    name=raw["name"],
                    definition=raw["definition"],
                    note=raw.get("note", ""),
                    intent_type=intent_type,
                    scope=scope_of.get(code, "shot"),
                    value_set=value_sets.get(code),
                    open_value=code in open_values,
                    axis_id=axis_of.get(code),
                    knowledge=cards.get(code),
                )
            )

        tm = top_meta.get(name, {})
        tops.append(
            TopIntent(
                code=top_code,
                name=name,
                type_label=type_label,
                definition=raw_top["definition"],
                selection=tm.get("selection", "multi"),
                selection_hint=tm.get("hint", ""),
                sub_intents=subs,
            )
        )

    ontology = Ontology(
        version=labels.get("version", "v3"),
        top_intents=tops,
        axes=axes,
        confusable_rules=[ConfusableRule.model_validate(r) for r in meta["confusable_rules"]],
    )

    # -- cross-source integrity checks --
    codes = set(ontology.all_codes())
    expected = labels.get("total_sub")
    if expected is not None and len(codes) != expected:
        raise ValueError(f"labels_v3.json declares {expected} sub-intents, parsed {len(codes)}")
    for source, keys in [
        ("knowledge_v3.yaml", set(cards)),
        ("meta_v3.yaml sub_types", set(sub_types)),
        ("meta_v3.yaml scopes", set(scope_of)),
        ("meta_v3.yaml axes", set(axis_of)),
        ("meta_v3.yaml value_sets", set(value_sets)),
        ("meta_v3.yaml open_value", open_values),
    ]:
        unknown = keys - codes
        if unknown:
            raise ValueError(f"{source} references unknown sub-intent codes: {sorted(unknown)}")
    missing_cards = codes - set(cards)
    if missing_cards:
        logger.warning("Sub-intents without knowledge cards: %s", sorted(missing_cards))

    return ontology


@lru_cache(maxsize=1)
def load_ontology(base_dir: str | None = None) -> Ontology:
    """Load and merge the v3 ontology. Cached — the ontology is read-only.

    Args:
        base_dir: Directory holding the three source files.  Defaults to
            this module's directory.
    """
    base = Path(base_dir) if base_dir else Path(__file__).parent

    with open(base / "labels_v3.json", encoding="utf-8") as f:
        labels = json.load(f)
    with open(base / "meta_v3.yaml", encoding="utf-8") as f:
        meta = yaml.safe_load(f)
    with open(base / "knowledge_v3.yaml", encoding="utf-8") as f:
        knowledge = yaml.safe_load(f)

    return _merge(labels, meta, knowledge)
