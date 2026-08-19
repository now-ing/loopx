from __future__ import annotations

import json
from pathlib import Path

from loopx.agent_onboarding import build_agent_onboarding_packet


def _connected_project(tmp_path: Path) -> Path:
    project = tmp_path / "project"
    registry = project / ".loopx" / "registry.json"
    registry.parent.mkdir(parents=True)
    registry.write_text(
        json.dumps(
            {
                "schema_version": "0.1",
                "goals": [
                    {
                        "id": "dsh-native-goal",
                        "status": "active",
                        "repo": str(project),
                        "adapter": {
                            "kind": "generic_project_goal_v0",
                            "status": "connected",
                        },
                        "coordination": {
                            "agent_model": "peer_v1",
                            "registered_agents": ["dsh-native-agent"],
                        },
                    }
                ],
            }
        )
        + "\n",
        encoding="utf-8",
    )
    return project


def test_dsh_native_onboarding_discovers_independent_same_session_plugin(
    tmp_path: Path,
) -> None:
    project = _connected_project(tmp_path)
    packet = build_agent_onboarding_packet(
        project=project,
        agent_type="dsh-native",
        goal_id="dsh-native-goal",
        agent_id="dsh-native-agent",
    )

    activation = packet["host_loop_activation"]
    assert packet["agent_type"] == "deepseek-harness-native"
    assert activation["host_surface"] == "deepseek_harness_native_session"
    assert activation["host_mutation"]["host_tool"] == "loopx_goal_activate"
    assert activation["setup"]["package_path"] == "packages/dsh-loopx-plugin"
    assert "install_command_facade" not in packet["commands"]
    assert "--host-surface deepseek-harness-native" in packet["commands"][
        "bootstrap_command_pack"
    ]
    assert "packages/dsh-loopx-plugin" in packet["recommended_start"]
    assert "loopx_goal_activate" in packet["recommended_start"]
    assert "scripts/dsh_turn_host_adapter.py" not in json.dumps(packet)


def test_dsh_external_onboarding_keeps_existing_adapter_contract(tmp_path: Path) -> None:
    project = _connected_project(tmp_path)
    packet = build_agent_onboarding_packet(
        project=project,
        agent_type="dsh",
        goal_id="dsh-native-goal",
        agent_id="dsh-native-agent",
    )

    activation = packet["host_loop_activation"]
    assert packet["agent_type"] == "deepseek-harness"
    assert activation["host_surface"] == "deepseek_harness_automation_loop"
    assert activation["activation_method"] == "external_loop_driver"
    assert "scripts/dsh_turn_host_adapter.py" in activation["entry_command_hint"]
    assert "loopx[deepseek-harness]" in packet["recommended_start"]
