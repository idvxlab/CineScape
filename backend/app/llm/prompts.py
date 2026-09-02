"""Prompt templates for each graph node.

Each builder method constructs (system_prompt, user_prompt) tuples for a
specific node's LLM call.  Prompts are grounded in the design space v3
(12 first-level x 56 second-level intents, A/B types + knowledge cards)
and never hard-code director personas or style cards.

ADR-0010 three-layer reasoning chain (the spine of pure-reasoning generation):
    B-class effect intent (what the audience should feel)
      -> psychological/perceptual mechanism (why they feel it)
      -> A-class means intent (how to arrange the frame)
      -> ten parameters (concrete values; rationale cites intent codes)

The design-space digest is produced by the ontology module; prompts only
consume it. All prompt text is English so model output stays English
end-to-end.
"""

from __future__ import annotations

from typing import Any

# Output language rule: ALL user-facing text AND the nine shot-language field values,
# duration, and frame_edit_hint are written in English. Appended to every node system prompt
# so model output is fully English end-to-end (prompts/renderers downstream are English too).
_LANG_RULE = (
    "\n\n[Output language rule (must follow)] All user-facing display text must be written in "
    "**English**: reflection, widget prompts and option labels/ends, direction name and mechanism, "
    "strategy, rationale, overall_rationale, brief, critic issues and suggestions. "
    "The nine shot-language field values (shot_size, composition, angle, movement, focal_length, "
    "depth_of_field, lighting, color_tone, rhythm), duration, and frame_edit_hint must ALSO be "
    'written in concise cinematic **English** (e.g. "extreme wide", "low angle / dutch tilt", '
    '"slow push-in", "shallow depth of field", "cool teal grade", "5s"). '
    "No Chinese characters anywhere in the JSON output. "
    "Intent codes (e.g. 3.4) and dim (first-level intent names) stay as-is; do not translate them."
)


class PromptBuilder:
    """Constructs structured prompts for each pipeline node."""

    @staticmethod
    def _image_section(image_brief: str | None) -> str:
        """Shared prompt section for the user-uploaded base image (re-shoot semantics)."""
        if not image_brief:
            return ""
        return (
            "\n\n## Base-image analysis (this task = design a re-shoot for THIS frame)\n"
            f"{image_brief}\n"
            "Rule: the frame anchors only the SUBJECT and the SPACE (who, and in what environment); "
            "they must not be replaced. The shooting style - light/color/camera/shot size/rhythm/"
            "mood - fully follows the user's intent and may differ drastically from the source "
            "image's look (e.g. a comedic frame re-shot as horror). "
            "The frame's current lighting and mood are only the status quo, NOT the user's direction."
        )

    @staticmethod
    def align_intent(
        design_space: str,
        current_intent: dict[str, Any],
        user_input: str,
        image_brief: str | None = None,
    ) -> tuple[str, str]:
        """Align agent prompt.

        System: Intent alignment specialist role description.
        User: design space digest + current intent state + user input.
        Expected output JSON: reflection, dimension_updates, widgets, ready_to_generate
        """
        system = (
            "You are an intent-alignment specialist. Map the user's vague expression onto the "
            "Director-Intent Design Space (12 first-level x 56 second-level intents) by asking "
            "the fewest questions needed to clarify it.\n\n"
            "Intents fall into two classes, asked about differently:\n"
            "- B class (effect intents: emotion evocation / atmosphere / empathy / curiosity, "
            'suspense, surprise): ask "what do you want the audience to feel?"\n'
            "- A class (means intents: attention / viewpoint / characterization / pacing / "
            'information / exposition / space / composition / meaning): ask "how do you want to '
            'arrange the frame?"\n'
            "Users usually state the B-class effect first; if the user shows no clear preference "
            "on A-class means, leave those to the generation stage to reason about - do not "
            "interrogate.\n\n"
            "How to reason about what to ask:\n"
            "- Read everything known and judge, for THIS one intent: which dimensions both matter "
            "most to the final shot language AND are still unclear - ask about those first.\n"
            "- When the user's expression falls into a confusable zone (see the discrimination "
            "rules at the end of the design space), ask the corresponding probe to disambiguate.\n"
            "- When a second-level intent is marked with a value set (e.g. 5.1-5.4), ask for the "
            "concrete value.\n"
            "- When a bipolar axis is hit (pace fast/slow, spatial scale, composition "
            "stability/tension), use a slider control.\n"
            "- At most 3 controls per round.\n\n"
            "Dimension statuses are qualitative: open / leaning / resolved / conflicting / "
            "blocked_by:X. Reason them out; never assign numeric scores.\n\n"
            "Output JSON:\n"
            "{\n"
            '  "reflection": "one sentence the user can accept or reject",\n'
            '  "dimension_updates": {"<intent-name>": '
            '{"value": "...", "candidates": ["sub-intent code"], "status": "..."}},\n'
            '  "widgets": [...],\n'
            '  "ready_to_generate": false\n'
            "}\n\n"
            "Widget protocol (kind can only be one of these; keep field names exact):\n"
            '- single {"kind": "single", "dim": "<intent-name>", "prompt": "<question>", '
            '"options": [{"value": "sub-intent code", "label": "plain-language label", '
            '"hint": "optional note"}]}\n'
            '- multi {"kind": "multi", same as single otherwise}\n'
            '- slider {"kind": "slider", "dim": "<intent-name>", "prompt": "<question>", '
            '"ends": ["left-end label", "right-end label"], "ticks": ["6.1", "6.2"]}\n'
            '- freetext {"kind": "freetext", "prompt": "<question>", '
            '"suggestions": ["suggestion 1"]}\n'
            'Every option value must be a second-level intent code (e.g. "8.3").'
        )
        system = system + _LANG_RULE
        user = (
            f"## Design Space (12 first-level x 56 second-level)\n{design_space}\n\n"
            f"## Current Intent State\n{current_intent}\n\n"
            f"## Latest user input\n{user_input}"
            f"{PromptBuilder._image_section(image_brief)}"
        )
        if image_brief:
            user += (
                "\n\nNote: the frame's subject and space may be used as evidence for dimension "
                "inference (e.g. spatial representation / characterization), but the frame's "
                "current mood/lighting is only the status quo - emotion/mood-class dimensions "
                "follow the user's words; if the user has not said, ask, never infer from the "
                "frame's status quo."
            )
        return system, user

    @staticmethod
    def check_convergence(
        design_space: str,
        intent_state: dict[str, Any],
        dialogue_history: list[dict],
        image_brief: str | None = None,
    ) -> tuple[str, str]:
        """Convergence checker prompt.

        Judges whether alignment can converge and proceed to generation.
        """
        system = (
            "You judge whether alignment can converge and proceed to generation.\n\n"
            "1. Maintain the 'sticky key-dimension set': which first-level dimensions are key "
            "for THIS intent? Give one reason each.\n"
            "   Use the counterfactual test: 'if this dimension switched to another second-level "
            "intent, would the direction-level shot strategy change?' No -> not key.\n"
            "2. Judge each key dimension: resolved / acceptable leaning / conflicting / "
            "blocked_by. A 'resolved' must be able to state its downstream shot consequence; "
            "if it cannot, it is either not key or not truly settled.\n"
            "3. Check confusable traps: if a selected second-level intent sits across two sides "
            "of a discrimination rule (e.g. 1.2 vs 8.3), confirm the user's words support the "
            "claimed side; if unsure, do NOT converge - ask the discrimination question.\n"
            "4. Before letting it pass, output a falsifiable reflection for the user to confirm.\n\n"
            "Convergence products:\n"
            '- tags: list of chosen second-level intent codes (e.g. ["3.4", "10.2", "7.1"]); '
            "include B-class effects and the clearly-chosen A-class means; intents with a value "
            "set state their value in the brief.\n"
            "- brief: one paragraph synthesizing the raw intent plus all dimension conclusions; "
            "it is the single intent statement for the generation stage.\n\n"
            "Output JSON:\n"
            "{\n"
            '  "key_dimensions": {"<intent-name>": {"reason": "..."}},\n'
            '  "per_dim_judgment": {"<intent-name>": {"status": "...", "consequence": "..."}},\n'
            '  "converge": false,\n'
            '  "defer_to_stage2": [],\n'
            '  "reflection": "...",\n'
            '  "brief": "...",\n'
            '  "tags": ["sub-intent code"]\n'
            "}"
        )
        system = system + _LANG_RULE
        user = (
            f"## Design Space (12 first-level x 56 second-level)\n{design_space}\n\n"
            f"## Intent State (with key_dimensions)\n{intent_state}\n\n"
            f"## Dialogue history\n{dialogue_history}"
            f"{PromptBuilder._image_section(image_brief)}"
        )
        return system, user

    @staticmethod
    def strategy_directions(
        intent_state: dict[str, Any],
        knowledge: str,
        constraints: str,
        exemplars: list[dict] | None = None,
        image_brief: str | None = None,
    ) -> tuple[str, str]:
        """Strategy enumeration prompt (ADR-0010: derive directly from the design space)."""
        system = (
            "You are a shot designer. For the converged intent set, enumerate at most 3 genuinely "
            "different cinematic directions within the design space.\n\n"
            "What counts as 'genuinely different': a different dominant mechanism family - the "
            "same effect intent can be reached through different compositional paths.\n"
            "Example - 'loneliness': (a) the spatial-representation path - tiny/engulfed "
            "dominant, big scale with negative space; (b) the viewpoint/empathy path - "
            "subjective immersion + intimate closeness dominant, shallow-focus close-ups; "
            "(c) the atmosphere/pacing path - detached mood + slowed stagnation dominant, "
            "long static takes. Surface changes in shot size or color grading do NOT make a "
            "different direction; a different mechanism does.\n\n"
            "Reasoning chain (complete it for every direction):\n"
            "B-class effect intent -> the psychological/perceptual mechanism for that effect "
            "(use the knowledge cards) -> the dominant A-class means intent -> an overview of "
            "the core technique.\n\n"
            "The number of directions depends on how many mechanism paths the intent set "
            "actually supports - do not force 3. When the intent already specifies the means, "
            "1-2 directions are fine. If library exemplars are attached, they only corroborate; "
            "a direction must stand on its own independent of any exemplar.\n\n"
            "Output JSON:\n"
            "{\n"
            '  "directions": [\n'
            "    {\n"
            '      "id": "A",\n'
            '      "name": "direction name (mechanism-path label, e.g. spatial-engulfment path)",\n'
            '      "dominant_intents": ["dominant second-level intent code"],\n'
            '      "mechanism": "the perceptual/psychological mechanism this direction relies on '
            '(one or two sentences)",\n'
            '      "core_technique": "overview of the core technique"\n'
            "    }\n"
            "  ]\n"
            "}"
        )
        system = system + _LANG_RULE
        user = (
            f"## Intent State (brief and tags)\n{intent_state}\n\n"
            f"## Knowledge cards of the selected intents (mechanism + candidate techniques)\n"
            f"{knowledge}\n\n"
            f"## Constraints (confusable / bipolar axis)\n{constraints}"
            f"{PromptBuilder._image_section(image_brief)}"
        )
        if image_brief:
            user += (
                "\n\nNote: every direction is a re-shoot of this base frame - the subject and "
                "space must not be replaced; camera/lighting/color/rhythm fully follow the "
                "intent and may look drastically different from the source image."
            )
        if exemplars:
            user += f"\n\n## Library exemplars (optional enrichment)\n{exemplars}"
        return system, user

    @staticmethod
    def generate_direction(
        intent_state: dict[str, Any],
        direction: dict[str, Any],
        knowledge: str,
        critic_feedback: str | None = None,
        image_brief: str | None = None,
        active_skill: dict | None = None,
        style_note: str | None = None,
    ) -> tuple[str, str]:
        """Generate one direction's shot script (plan -> detail, pure reasoning)."""
        system = (
            "You are a shot designer. Generate a complete shot script along the given mechanism direction.\n\n"
            "Reasoning discipline (three-layer chain, do not skip levels):\n"
            "effect intent (what the audience should feel) -> mechanism (why they feel it; see knowledge cards) -> "
            "compositional arrangement (what the frame does) -> the ten parameter values.\n"
            "Every shot's parameter choices must trace back along this chain; do not write a parameter you cannot justify.\n\n"
            "Step 1 - plan: first emit the shot-sequence skeleton (each beat: its intent function + approximate shot size/camera move), "
            "carrying the mechanism DNA of this direction; note that scene-scoped intents (e.g. atmosphere) must run through ALL shots, "
            "while sequence-scoped intents are realized through relations between shots.\n"
            "Step 2 - detail: fill every beat into a full ten-parameter shot.\n"
            "- serves: list of sub-intent codes this shot serves (required; only codes inside tags).\n"
            "- rationale: explain along the mechanism chain why the parameters serve these intents.\n"
            "Draw techniques from the knowledge cards, but rewrite them for THIS precise intent; do not copy a referenced film.\n\n"
            'Hard constraint - duration (must satisfy): duration is in seconds (like "5s"). '
            "(1) A single shot must not exceed 5 seconds; (2) the sum of all shot durations in a scheme must not exceed 15 seconds. "
            "Plan the shot count and each duration at the plan stage (e.g. three shots of 5s each); "
            "the detail stage must not break these two caps.\n\n"
            "Iron rule: intent fidelity > stylistic flourish. When a knowledge-card technique conflicts with the brief, follow the brief.\n\n"
            "Output JSON:\n"
            "{\n"
            '  "scheme_id": "A",\n'
            '  "strategy": "direction description",\n'
            '  "dominant_intents": ["sub-intent code"],\n'
            '  "mechanism": "the mechanism in one or two sentences",\n'
            '  "shots": [\n'
            "    {\n"
            '      "order": 1,\n'
            '      "shot_size": "...", "composition": "...", "angle": "...",\n'
            '      "movement": "...", "focal_length": "...", "depth_of_field": "...",\n'
            '      "lighting": "...", "color_tone": "...", "rhythm": "...", "duration": "...",\n'
            '      "serves": ["sub-intent code"],\n'
            '      "rationale": "mechanism-chain rationale",\n'
            '      "frame_edit_hint": "required when a base image is provided, otherwise leave empty"\n'
            "    }\n"
            "  ],\n"
            '  "overall_rationale": "how the whole scheme reaches the effect intent along the mechanism"\n'
            "}\n\n"
            "frame_edit_hint (only when a base image is provided): this shot's re-shoot instruction - "
            "write it in English: one or two actionable sentences an image-edit model can execute, "
            "covering reframing / shot-size change, subject placement, lighting & color shift, e.g. "
            '"Pull back to an extreme wide shot, subject shrinks to the lower right, grade the whole '
            'frame dark and cold blue-grey, shadows swallow the background." '
            "Keep the subject and spatial layout recognizable; the stylistic change may be as drastic "
            "as the intent requires."
        )
        system = system + _LANG_RULE
        from app.evolution import skill_prompt_section

        user = (
            f"## Intent State (brief and tags)\n{intent_state}\n\n"
            f"## This direction (mechanism path)\n{direction}\n\n"
            f"## Relevant knowledge cards\n{knowledge}"
            f"{PromptBuilder._image_section(image_brief)}"
            f"{skill_prompt_section(active_skill)}"
            f"{style_note or ''}"
        )
        if critic_feedback:
            user += (
                "\n\n## Critic revision feedback (this is a REGENERATION: fix every issue below one by one, keep the direction otherwise unchanged)\n"
                f"{critic_feedback}"
            )
        return system, user

    @staticmethod
    def critic(
        intent_state: dict[str, Any],
        shot_script: dict[str, Any],
        constraints: str,
        knowledge: str,
        skill_checks: list[str] | None = None,
    ) -> tuple[str, str]:
        """Critic review prompt.

        Layers: parameter coupling (hard rules run before this call) +
        mechanism-chain fidelity + confusable misuse + bipolar-axis consistency.
        """
        system = (
            "You are a consistency reviewer. Check the scheme item by item:\n\n"
            "1. Parameter logic: the shots in a scheme must be coherent - tonal/lighting harmony. "
            "Three coupled parameter groups:\n"
            "   - space/frame group: shot size, focal length, depth of field, composition, angle\n"
            "   - time/motion group: camera movement, rhythm, duration\n"
            "   - tonal/mood group: lighting, color\n\n"
            "2. Mechanism-chain fidelity (core):\n"
            "   - every code cited in a shot's serves must be inside the converged tags; citing "
            "a code outside tags is a failure.\n"
            "   - against the knowledge card: do the parameter values really serve the mechanism "
            "the rationale claims? If a mechanism is stated but the parameters do not support it "
            "-> intent_fidelity failure.\n"
            "   - do scene-scoped intents (e.g. atmosphere) run through ALL shots, not just one "
            "or two?\n\n"
            "3. Confusable misuse: which side of the discrimination rule does the script's actual "
            "effect fall on? Mismatch with the claimed side of the tags -> failure (e.g. tags say "
            "suspense 8.3, the script only made emotional tension 1.2).\n\n"
            "4. Bipolar-axis consistency: shots in the same scheme must not serve both poles of "
            "one axis at once, unless the rationale explicitly frames it as a deliberate contrast.\n\n"
            "5. Preference soft checks (only when provided below, ADR-0017): check item by item "
            "whether the script reflects them; **they may only appear in suggestions and must "
            "never be a reason for passed=false**; ignore a soft check when it conflicts with any "
            "hard rule above (intent fidelity / ontology / serves / coupling).\n\n"
            "Output JSON:\n"
            "{\n"
            '  "passed": true,\n'
            '  "issues": [{"type": "param_coupling"|"intent_fidelity"'
            '|"confusable_misuse"|"axis_conflict",\n'
            '              "shot_order": 1, "field": "...", "message": "..."}],\n'
            '  "suggestions": ["..."]\n'
            "}"
        )
        system = system + _LANG_RULE
        user = (
            f"## Intent State (brief and tags)\n{intent_state}\n\n"
            f"## Shot Script\n{shot_script}\n\n"
            f"## Constraints (confusable / bipolar axis)\n{constraints}\n\n"
            f"## Relevant knowledge cards (mechanism reference)\n{knowledge}"
        )
        if skill_checks:
            checks = "\n".join(f"- {c}" for c in skill_checks)
            user += f"\n\n## Preference soft checks (user-corroborated preferences; suggestions only, never a failure reason)\n{checks}"
        return system, user

    @staticmethod
    def discover_questions(
        evidence_digest: dict[str, Any],
        existing_questions: list[dict[str, Any]],
    ) -> tuple[str, str]:
        """Discovery prompt (ADR-0017): propose preference *questions* from a
        session's interaction cues.

        A first behavioural occurrence proposes a question; later independent
        behavioural recurrences vote on a matched question. Explicit probes are
        an additional route. All user-facing fields are English.
        """
        system = (
            "You are a preference-question discoverer. From the interaction cues of one creative "
            "session, propose **preference questions** about THIS user. Core creed: behaviour "
            "**proposes** a question; when the same decision **recurs** in a later session and "
            "hits an existing question, the behaviour casts **one vote** for the side it "
            "favoured, advancing the question's state like a probe answer "
            "(observed -> tentative -> corroborated). A first proposal only creates the question "
            "(observed, no vote); a recurrence is evidence. Full candidates usually differ along "
            "several dimensions and cannot be cleanly attributed, so a first occurrence never "
            "asserts a side - but when an existing narrow question is hit, this session did lean "
            "one way and you must say which.\n\n"
            "A preference question q=(c,d,a,b):\n"
            "- c (context/scope): take it **from the chosen direction's dominant_intents** (see "
            "comparisons[].selected.dominant_intents or digest.dominant_intents) - choose the "
            "intent most directly related to this preference parameter as the intent_leaf "
            "scope_id (the preference comes from that choice, so it belongs to the intent that "
            "choice served, not to any other tag in the session). Cross-scene consistent style "
            "(e.g. static camera in movement, warm/cool in color_tone) binds no single intent - "
            "use global; mechanism is also allowed.\n"
            "   WARNING: never attribute the preference to an intent the chosen direction did "
            "not serve, or future sessions of the same kind cannot recall it nor attribute it "
            "correctly.\n"
            "- d (decision axis): one concrete cinematic trade-off (e.g. how to handle threat "
            "visibility).\n"
            "- a, b: two alternatives that are executable inside the design space, each with a "
            "label and a detail (ten-parameter field -> value).\n"
            "  Optional detail fields: shot_size/composition/angle/movement/focal_length/"
            "depth_of_field/lighting/color_tone/rhythm/duration; may also carry intent_codes, "
            "plan{shot_count,sequence_pattern}.\n"
            "- Give each alternative a mechanism where possible: one sentence on the "
            "psychological/perceptual mechanism it serves. It will become the reasoning-chain "
            "fragment of the workflow skill once the preference is corroborated, addressed to "
            "future generators.\n\n"
            "Output language (strict): decision, label, mechanism are user-facing - write them "
            "in **English**; detail field values must also be written in concise cinematic "
            "**English** (consistent with the shot script).\n\n"
            "Discipline:\n"
            "- Only ask when the interaction cues **really imply a binary trade-off**; situational "
            "patches (pulling back only because the subject is too small in this frame) must not "
            "become preferences.\n"
            "- interaction_verdicts are the user's explicit per-field keep/revert/refine "
            "outcomes; even without a render they are real interactive-edit evidence. revert "
            "means rejecting proposed and restoring final; refine means rejecting proposed and "
            "adopting final. perceptual_verdicts are visual evidence only when a render actually "
            "succeeded.\n"
            "- a and b must be opposites on the same decision axis and both executable inside "
            "the design space.\n"
            "- When an existing question is hit, give match_question_id and **match_answer**: the "
            'side this session\'s behaviour leans to ("a"/"b"); if the session shows no clear '
            'lean on either side, give "open". Questions the user has revoked must not be '
            "proposed again.\n"
            "- No numeric scores / confidence. When **creating** a question, never assert a side "
            "(match_answer is given only on a hit).\n\n"
            "Output JSON:\n"
            "{\n"
            '  "questions": [\n'
            "    {\n"
            '      "match_question_id": null,\n'
            '      "match_answer": "a|b|open on a hit; omit when creating",\n'
            '      "scope_type": "intent_leaf|mechanism|global",\n'
            '      "scope_id": "6.2 or mechanism-family name or null",\n'
            '      "decision": "one-sentence decision axis (English)",\n'
            '      "alt_a": {"label": "English label", "detail": {"movement": "locked-off"},'
            ' "mechanism": "optional English", "intent_codes": ["optional"]},\n'
            '      "alt_b": {"label": "English label", "detail": {"movement": "slow push-in"}}\n'
            "    }\n"
            "  ]\n"
            "}"
        )
        user = (
            f"## Interaction cues of this session (deterministically pre-processed)\n"
            f"{evidence_digest}\n\n"
            f"## Existing preference questions of this user (match_question_id on a hit; "
            f"revoked ones must not be re-proposed)\n"
            f"{existing_questions}"
        )
        return system, user

    @staticmethod
    def edit_revalidate(
        shot_script: dict[str, Any],
        edit_patch: dict[str, Any],
    ) -> tuple[str, str]:
        """Edit collaboration: validate a user edit for consistency."""
        system = (
            "You are an edit-collaboration assistant. A user edited a shot script; "
            "check whether the edit breaks parameter consistency, and whether it weakens the intent "
            "that this shot's serves claims to serve.\n\n"
            "If the edit is sound, return empty conflicts.\n"
            "If the edit creates a conflict (e.g. changing the shot size to a close-up while keeping a "
            "large negative-space composition), list the conflicts.\n\n"
            "Output JSON:\n"
            "{\n"
            '  "conflicts": [{"shot_order": 1, "field": "...", "message": "..."}],\n'
            '  "suggestions": ["..."]\n'
            "}\n"
            "conflict.message is user-facing: write it in English."
        )
        system = system + _LANG_RULE
        user = f"## Original script\n{shot_script}\n\n## Edit\n{edit_patch}"
        return system, user
