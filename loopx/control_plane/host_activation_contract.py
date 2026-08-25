"""Typed host-activation contract and quota-gate enforcement validation."""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Any


HOST_ACTIVATION_CONTRACT_SCHEMA_VERSION = "loopx_host_activation_contract_v0"


class QuotaGateEnforcement(StrEnum):
    """Enforcement semantics for quota should-run entry in a host loop.

    - ``ENFORCED``: host or outer driver intercepts loop continuations and
      enforces quota decisions before execution.
    - ``ADVISORY_ONLY``: host lacks native continuation interception hooks;
      the skill facade provides instructed pacing guidance to the model/agent.
    """

    ENFORCED = "enforced"
    ADVISORY_ONLY = "advisory_only"

    @classmethod
    def parse(
        cls,
        value: str | QuotaGateEnforcement | None,
        *,
        default: QuotaGateEnforcement = ENFORCED,
    ) -> QuotaGateEnforcement:
        if value is None:
            return default
        if isinstance(value, cls):
            return value
        raw = str(value).strip().lower()
        for member in cls:
            if member.value == raw:
                return member
        allowed = ", ".join(f"`{item.value}`" for item in cls)
        raise ValueError(
            f"unsupported quota_gate_enforcement `{value}`; use one of: {allowed}"
        )


def derive_host_agent_scope(
    host_label: str,
    enforcement: QuotaGateEnforcement | str = QuotaGateEnforcement.ENFORCED,
) -> str:
    """Derive operator-facing heartbeat agent scope from host label and typed enforcement."""
    mode = QuotaGateEnforcement.parse(enforcement)
    if mode is QuotaGateEnforcement.ADVISORY_ONLY:
        return f"{host_label} agent loop with advisory LoopX quota pacing"
    return f"{host_label} agent loop gated by LoopX"


def derive_host_loop_description(
    host_label: str,
    enforcement: QuotaGateEnforcement | str = QuotaGateEnforcement.ENFORCED,
    *,
    native_details: str | None = None,
) -> str:
    """Derive host_loop text in catalog from host label, enforcement, and optional native details."""
    mode = QuotaGateEnforcement.parse(enforcement)
    if mode is QuotaGateEnforcement.ADVISORY_ONLY:
        if native_details:
            return f"{native_details} (LoopX quota pacing is advisory)"
        return f"{host_label} agent loop with advisory LoopX quota pacing"
    if native_details:
        return f"{native_details} gated by LoopX quota"
    return f"agent-driven {host_label} loop gated by LoopX quota should-run"


@dataclass(frozen=True, slots=True)
class HostActivationExtras:
    """Typed container for host-specific activation overrides."""

    activation_method: str
    quota_gate_enforcement: QuotaGateEnforcement
    extra_host_mutation: dict[str, Any]
    extra_activation_steps: list[str]
    host_scheduler_note: str | None = None

    def to_dict(self) -> dict[str, Any]:
        mutation = dict(self.extra_host_mutation)
        mutation["quota_gate_enforcement"] = self.quota_gate_enforcement.value
        result: dict[str, Any] = {
            "activation_method": self.activation_method,
            "quota_gate_enforcement": self.quota_gate_enforcement.value,
            "extra_host_mutation": mutation,
            "extra_activation_steps": list(self.extra_activation_steps),
        }
        if self.host_scheduler_note is not None:
            result["host_scheduler_note"] = self.host_scheduler_note
        return result


def validate_host_activation_packet(packet: dict[str, Any]) -> dict[str, Any]:
    """Validate host activation packet at the control plane descriptor boundary.

    Guarantees ``quota_gate_enforcement`` in ``host_mutation`` (if present)
    matches a valid ``QuotaGateEnforcement`` enum value and rejects unknown
    or renamed enforcement modes.
    """
    if not isinstance(packet, dict):
        raise ValueError(
            f"expected dict for host activation packet, got {type(packet).__name__}"
        )
    host_mutation = packet.get("host_mutation")
    if isinstance(host_mutation, dict) and "quota_gate_enforcement" in host_mutation:
        mode = QuotaGateEnforcement.parse(host_mutation["quota_gate_enforcement"])
        host_mutation["quota_gate_enforcement"] = mode.value
    return packet
