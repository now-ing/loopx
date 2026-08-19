import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { LoopXBindingRow } from './types.ts'

const safeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const nonEmpty = z.string().min(1)
const publicAgentId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/u)

export const loopxSessionIdentitySchema = z.object({
  createdAt: safeInteger,
  cwd: nonEmpty.optional(),
})

export const loopxBindingPhaseSchema = z.enum([
  'planning',
  'active_paused',
  'active_armed',
  'uncertain',
])

export const loopxBindingReasonSchema = z.enum([
  'cold_restore',
  'user_pause',
  'foreign_input',
  'loopx_terminal_observed',
  'identity_conflict',
  'readback_failed',
  'uncertain_write',
  'session_disposed',
  'manual_resume_required',
])

export const loopxBindingRowSchema = z.object({
  schemaVersion: z.literal('loopx_dsh_binding_row_v0'),
  session: loopxSessionIdentitySchema,
  hostSurface: z.literal('deepseek-harness-native'),
  goalId: nonEmpty.max(256),
  agentId: publicAgentId,
  projectLocator: nonEmpty.max(4096),
  registryLocator: nonEmpty.max(4096).optional(),
  runtimeRootLocator: nonEmpty.max(4096).optional(),
  phase: loopxBindingPhaseSchema,
  generation: safeInteger.min(1),
  schedulerResetToken: nonEmpty.max(256).optional(),
  unchangedPollCount: safeInteger,
  nextCheckAt: safeInteger.optional(),
  reason: loopxBindingReasonSchema.optional(),
  bindingCreatedAt: safeInteger,
  updatedAt: safeInteger,
}).refine(row => row.updatedAt >= row.bindingCreatedAt, {
  path: ['updatedAt'],
  message: 'updatedAt must not precede bindingCreatedAt',
}) satisfies z.ZodType<LoopXBindingRow>

export const loopxBindingDomainSpec = defineDomain({
  name: 'dsh_loopx_plugin',
  version: 0,
  tables: {
    sessions: domainTable<string, LoopXBindingRow>(loopxBindingRowSchema),
  },
})

const selectionChoiceSchema = z.looseObject({
  agent_id: publicAgentId,
  label: nonEmpty.optional(),
})

export const identitySelectionGateSchema = z.looseObject({
  schema_version: z.literal('loopx_host_loop_identity_selection_v0'),
  default_action: nonEmpty,
  reason: nonEmpty.optional(),
  choices: z.array(selectionChoiceSchema).default([]),
  fresh_agent_registration: z.looseObject({
    agent_id: nonEmpty.optional(),
  }).optional(),
})

export const goalSelectionGateSchema = z.looseObject({
  schema_version: z.literal('loopx_goal_selection_gate_v0'),
  state: z.literal('selection_required'),
  reason: nonEmpty,
  choices: z.array(z.looseObject({
    goal_id: nonEmpty,
  })),
})

export const threadBindingProjectionSchema = z.looseObject({
  status: z.enum(['bound', 'missing', 'conflict', 'unavailable']),
  agent_id: publicAgentId.optional(),
})

const guidedStepSchema = z.looseObject({
  id: nonEmpty,
  kind: nonEmpty,
  prompt: nonEmpty.optional(),
})

export const startGoalGuidedSchema = z.looseObject({
  schema_version: z.literal('loopx_start_goal_guided_v0'),
  ok: z.boolean(),
  read_only: z.literal(true).optional(),
  guided: z.literal(true).optional(),
  project: nonEmpty.optional(),
  goal_id: nonEmpty.optional(),
  agent_id: publicAgentId.nullish(),
  host_surface: z.literal('deepseek-harness-native').optional(),
  thread_id: nonEmpty.optional(),
  thread_agent_binding: threadBindingProjectionSchema.optional(),
  goal_selection_gate: goalSelectionGateSchema.optional(),
  host_surface_selection_gate: z.looseObject({}).optional(),
  project_connection: z.looseObject({
    registry: nonEmpty.optional(),
  }).optional(),
  guided_transaction: z.looseObject({
    schema_version: z.literal('loopx_start_goal_guided_v0'),
    blocked_by: nonEmpty.optional(),
    identity_selection_gate: identitySelectionGateSchema.optional(),
    ordered_steps: z.array(guidedStepSchema),
  }).optional(),
})

const nativeActivationFields = {
  host_surface: z.literal('deepseek_harness_native_session'),
  activation_method: z.literal('current_session_host_tool'),
  activation_input: z.looseObject({
    schema_version: z.literal('loopx_deepseek_harness_native_activation_input_v0'),
    tool: z.literal('loopx_goal_activate'),
    arguments: z.looseObject({
      goalId: nonEmpty,
      agentId: publicAgentId.optional(),
    }),
  }),
  host_mutation: z.looseObject({
    owner: z.literal('DSH LoopX plugin'),
    host_tool: z.literal('loopx_goal_activate'),
    current_session_only: z.literal(true),
    cli_can_mutate_directly: z.literal(false),
    forbidden_tool_arguments: z.array(z.string()),
  }),
} as const

export const bootstrapCommandPackSchema = z.looseObject({
  schema_version: z.literal('loopx_bootstrap_command_pack_v0'),
  ok: z.boolean(),
  read_only: z.literal(true),
  project: nonEmpty,
  goal_id: nonEmpty,
  agent_id: publicAgentId.nullish(),
  agent_type: z.literal('deepseek-harness-native'),
  host_surface: z.literal('deepseek-harness-native'),
  thread_id: nonEmpty.optional(),
  thread_agent_binding: threadBindingProjectionSchema.optional(),
  project_connection: z.looseObject({
    registry: nonEmpty.optional(),
  }).optional(),
  host_loop_activation: z.looseObject({
    schema_version: z.literal('loopx_host_loop_activation_v1'),
    agent_type: z.literal('deepseek-harness-native'),
    goal_id: nonEmpty,
    agent_id: publicAgentId.nullish(),
    activation_allowed: z.boolean(),
    identity_contract: z.looseObject({
      schema_version: z.literal('loopx_host_loop_identity_selection_v0'),
      registered_agents: z.array(publicAgentId),
    }),
    identity_selection_gate: identitySelectionGateSchema.nullish(),
    ...nativeActivationFields,
  }),
})

export const heartbeatPromptSchema = z.looseObject({
  schema_version: z.literal('loopx_heartbeat_prompt_v0'),
  ok: z.boolean(),
  goal_id: nonEmpty,
  agent_id: publicAgentId.nullish(),
  runtime_profile: z.literal('generic_cli').optional(),
  task_body: nonEmpty.nullish(),
})

export const statusSchema = z.looseObject({
  schema_version: z.literal('loopx_status_v0'),
  ok: z.boolean(),
  goal_filter: nonEmpty.nullish(),
})

const schedulerHintSchema = z.looseObject({
  schema_version: z.literal('scheduler_hint_v0'),
  source: z.literal('quota.should-run'),
  action: nonEmpty,
  cadence_class: nonEmpty,
  reset_policy: z.looseObject({
    reset_token: nonEmpty,
  }),
  unchanged_poll: z.looseObject({
    limits: z.looseObject({
      local_scheduler: safeInteger.nullish(),
    }).optional(),
    after_limits: z.looseObject({
      local_scheduler: nonEmpty.optional(),
    }).optional(),
  }).optional(),
  cold_path_detail: z.looseObject({
    schema_version: z.literal('scheduler_hint_detail_v0'),
    local_scheduler: z.looseObject({
      recommended_interval_minutes: safeInteger.min(1),
      unchanged_poll_limit: safeInteger.nullish(),
      after_limit: nonEmpty,
    }),
  }),
})

const terminalStateSchema = z.looseObject({
  schema_version: z.literal('goal_terminal_state_v0'),
  kind: z.literal('no_followup'),
  derived: z.literal(true),
  source: z.literal('validated_goal_closure'),
})

const sourceCompletenessSchema = z.looseObject({
  schema_version: z.literal('goal_terminal_source_completeness_v0'),
  user_todos: z.literal('valid'),
  agent_todos: z.literal('valid'),
})

export const quotaShouldRunSchema = z.looseObject({
  schema_version: z.literal('loopx_quota_should_run_v0'),
  ok: z.boolean(),
  mode: z.literal('should-run'),
  goal_id: nonEmpty,
  should_run: z.boolean(),
  effective_action: nonEmpty,
  agent_identity: z.looseObject({
    agent_id: publicAgentId,
  }),
  scheduler_hint: schedulerHintSchema,
  heartbeat_receipt: z.looseObject({
    schema_version: z.literal('heartbeat_quota_receipt_v0'),
    turn_instance_id: nonEmpty,
    status: z.enum(['committed', 'replayed']),
  }).optional(),
  goal_frontier_projection: z.looseObject({
    terminal_state: terminalStateSchema.optional(),
    source_completeness: sourceCompletenessSchema.optional(),
    acceptance_gaps: z.array(z.unknown()).optional(),
    autonomy_blockers: z.array(z.unknown()).optional(),
    replan_required: z.boolean().optional(),
  }).optional(),
})

export const todoCommandSchema = z.looseObject({
  schema_version: z.literal('loopx_todo_command_v0'),
  ok: z.boolean(),
  goal_id: nonEmpty,
  todo_id: nonEmpty.optional(),
  status: nonEmpty.optional(),
  written: z.boolean().optional(),
})

export const registerAgentSchema = z.looseObject({
  schema_version: z.literal('loopx_register_agent_v0'),
  ok: z.boolean(),
  goal_id: nonEmpty,
  changed: z.boolean(),
  written: z.boolean(),
  registration_readback: z.looseObject({ verified: z.boolean() }).optional(),
  global_sync: z.looseObject({ ok: z.boolean().optional() }).optional(),
})

export const threadBindingCommandSchema = z.looseObject({
  schema_version: z.literal('loopx_thread_agent_binding_command_v0'),
  ok: z.boolean(),
  goal_id: nonEmpty,
  thread_id: nonEmpty.optional(),
  host_surface: z.literal('deepseek-harness-native').optional(),
  agent_id: publicAgentId.optional(),
  changed: z.boolean(),
  written: z.boolean(),
  binding: z.looseObject({
    schema_version: z.literal('loopx_thread_agent_binding_v0'),
    status: z.enum(['bound', 'missing', 'conflict', 'unavailable']),
    thread_id: nonEmpty,
    host_surface: z.literal('deepseek-harness-native'),
    agent_id: publicAgentId.nullish(),
  }).optional(),
  global_sync: z.looseObject({ ok: z.boolean().optional() }).optional(),
  registration_readback: z.looseObject({ verified: z.boolean() }).optional(),
})

export type StartGoalGuidedPayload = z.infer<typeof startGoalGuidedSchema>
export type BootstrapCommandPackPayload = z.infer<typeof bootstrapCommandPackSchema>
export type HeartbeatPromptPayload = z.infer<typeof heartbeatPromptSchema>
export type QuotaShouldRunPayload = z.infer<typeof quotaShouldRunSchema>
export type TodoCommandPayload = z.infer<typeof todoCommandSchema>
