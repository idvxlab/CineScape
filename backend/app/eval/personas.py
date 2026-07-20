"""Simulated creators with a known, held-out taste profile.

A persona's ``profile`` is ground truth for judging and is **never** shown to
the system: the system only observes the persona's widget answers, probe
answers, and edits. Profiles are authored to satisfy the preconditions the
convergence argument makes explicit (expressible in the design space, contexts
that recur), and each includes a conflicting pair on a shared parameter so that
skill enactment must resolve conflicts rather than merely accumulate.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class TasteEntry:
    """One ground-truth preference, in design-space terms.

    ``scope`` is the recurring context (an intent leaf code or 'global'),
    ``field`` a ten-parameter name, ``prefer``/``avoid`` the two poles.
    ``decision`` is the human-readable axis, used for matching against the
    questions the system discovers on its own.
    """

    scope: str
    decision: str
    field: str
    prefer: str
    avoid: str


@dataclass(frozen=True)
class Persona:
    persona_id: str
    label: str
    #: ground truth — withheld from the system, shown only to the judge
    profile: list[TasteEntry]
    #: preferences never exercised by the session themes (distractors): a
    #: system that "learns" these is over-claiming, so they lower precision
    distractors: list[TasteEntry] = field(default_factory=list)
    #: intent themes the learning sessions cycle through
    learn_themes: list[str] = field(default_factory=list)
    #: held-out themes used only in evaluation sessions
    eval_themes: list[str] = field(default_factory=list)
    #: probability the persona answers against its own profile (answer noise)
    noise: float = 0.1

    def profile_text(self) -> str:
        """Render the profile for the judge (never for the system)."""
        lines = [
            f"- For {e.scope} ({e.decision}): prefers {e.field}={e.prefer}, "
            f"avoids {e.field}={e.avoid}"
            for e in self.profile
        ]
        return "\n".join(lines)

    def entry_for(self, scope: str, field_name: str) -> TasteEntry | None:
        """The ground-truth entry governing a (scope, parameter) pair, if any."""
        for e in self.profile:
            if e.field == field_name and (e.scope == scope or e.scope == "global"):
                return e
        return None


# ---------------------------------------------------------------------------
# Persona bank
# ---------------------------------------------------------------------------

#: P1 — the withholder: dread through what is *not* shown; conflicting pair on
#: `movement` (global stillness vs. a deliberate slow push for the final beat).
P_WITHHOLDER = Persona(
    persona_id="p1-withholder",
    label="The withholder (suspense through concealment)",
    profile=[
        TasteEntry("8.3", "how a lurking threat is revealed",
                   "composition", "threat kept off-frame or at the edge",
                   "threat centered and fully shown"),
        TasteEntry("global", "camera stillness under tension",
                   "movement", "locked-off static", "handheld instability"),
        TasteEntry("8.3", "how the final beat closes",
                   "movement", "slow push-in", "abrupt cut to static"),
        TasteEntry("global", "tonal register",
                   "color_tone", "desaturated cool", "high-contrast warm"),
    ],
    distractors=[
        TasteEntry("1.4", "how sadness is framed",
                   "shot_size", "extreme wide", "close-up"),
    ],
    learn_themes=[
        "Re-shoot this as a Hitchcock suspense scene",
        "Make the viewer dread what is coming before the character notices",
        "A quiet moment that feels watched",
    ],
    eval_themes=[
        "Something is wrong in this room and only we can tell",
        "The calm before an unseen threat arrives",
    ],
)

#: P2 — the immersionist: subjective closeness; conflicts with P1 on movement,
#: so a mismatched-memory control between them is a strong validity check.
P_IMMERSIONIST = Persona(
    persona_id="p2-immersionist",
    label="The immersionist (feel it from inside)",
    profile=[
        TasteEntry("5.2", "how the audience is positioned",
                   "shot_size", "close-up on the subject", "extreme wide"),
        TasteEntry("global", "camera stillness under tension",
                   "movement", "handheld follow", "locked-off static"),
        TasteEntry("global", "depth rendering",
                   "depth_of_field", "shallow, subject isolated", "deep focus"),
        TasteEntry("6.2", "how time is stretched",
                   "rhythm", "long held takes", "fast cutting"),
    ],
    distractors=[
        TasteEntry("3.4", "how grandeur is staged",
                   "angle", "low angle", "high angle"),
    ],
    learn_themes=[
        "Put us inside her head as the tension rises",
        "Make the loneliness feel personal, not observed",
        "We should feel what the character feels here",
    ],
    eval_themes=[
        "A private moment we are too close to",
        "Her unease, felt from the inside",
    ],
)

PERSONAS: list[Persona] = [P_WITHHOLDER, P_IMMERSIONIST]


def persona_by_id(pid: str) -> Persona | None:
    return next((p for p in PERSONAS if p.persona_id == pid), None)


def ground_truth_pairs(persona: Persona) -> list[dict[str, Any]]:
    """Profile entries as plain dicts, for metric computation."""
    return [
        {"scope": e.scope, "field": e.field, "prefer": e.prefer,
         "avoid": e.avoid, "decision": e.decision}
        for e in persona.profile
    ]
