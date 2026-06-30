"""Widget protocol — server-driven UI for alignment phase.

Discriminated union: each widget variant has a `kind` literal that
the frontend registry switches on to render the correct control.
"""

from __future__ import annotations

from typing import Annotated, Literal, Union

from pydantic import BaseModel, Field


class Opt(BaseModel):
    """A single selectable option within a widget."""

    value: str
    label: str
    hint: str | None = None


class SingleWidget(BaseModel):
    """Single-choice widget for one ontology dimension."""

    kind: Literal["single"] = "single"
    dim: str
    prompt: str
    options: list[Opt]


class MultiWidget(BaseModel):
    """Multi-choice widget for one ontology dimension."""

    kind: Literal["multi"] = "multi"
    dim: str
    prompt: str
    options: list[Opt]


class SliderWidget(BaseModel):
    """Continuous-scale widget bounded by two semantic endpoints."""

    kind: Literal["slider"] = "slider"
    dim: str
    prompt: str
    ends: tuple[str, str]
    ticks: list[str] | None = None


class FreeTextWidget(BaseModel):
    """Free-text input, optionally tied to a dimension."""

    kind: Literal["freetext"] = "freetext"
    dim: str | None = None
    prompt: str
    suggestions: list[str] = []


class ConfirmWidget(BaseModel):
    """Reflection confirmation — user can accept or reject the summary."""

    kind: Literal["confirm"] = "confirm"
    reflection: str


Widget = Annotated[
    Union[SingleWidget, MultiWidget, SliderWidget, FreeTextWidget, ConfirmWidget],
    Field(discriminator="kind"),
]
