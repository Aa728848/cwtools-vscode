# AI Workflow System Implementation Plan

## Goal

Move the AI feature set from a collection of powerful tools into repeatable workflows for common modding tasks. The workflows should make agent behavior easier to predict, easier to test, and easier for users to trust.

## Current Signals

- AI modes, tool definitions, runner policy, orchestrator, review mode, and sub-agent execution already exist.
- Tool safety tests exist under `client/test/unit/agentToolSafety.test.ts`.
- Common user tasks are visible in commands and tools: review current file, explain selection, fix diagnostics, localisation writing, rule queries, asset search, and design blueprints.
- The current system has many capabilities but does not expose them as stable user-facing recipes.

## Workflow Candidates

Start with five workflows:

1. Diagnostic Fix Workflow
2. Localisation Generation Workflow
3. Event Chain Design Workflow
4. Rules Sync Review Workflow
5. Asset Wiring Workflow

Each workflow should define:

- entry command or chat intent
- required context
- allowed tools
- required verification
- output format
- rollback or user confirmation behavior

## Proposed Contract

```ts
export interface AiWorkflow {
    id: string;
    title: string;
    description: string;
    mode: AgentMode;
    requiredContext: WorkflowContextRequirement[];
    toolPolicy: WorkflowToolPolicy;
    phases: WorkflowPhase[];
    verification: WorkflowVerificationStep[];
}
```

## Phase 1: Define Workflow Metadata

1. Add a workflow registry module under `client/extension/ai/`.
2. Model workflows as data first, not new runner code.
3. Add the first two workflows:
   - Diagnostic Fix
   - Localisation Generation
4. Expose workflow metadata to the chat panel for display.

## Phase 2: Runner Integration

1. Add optional `workflowId` to the agent run request.
2. Load workflow-specific prompt constraints in `promptBuilder.ts`.
3. Restrict or prioritize tools according to the workflow's tool policy.
4. Emit workflow phase steps into the existing agent step stream.

## Phase 3: User Experience

1. Add workflow launch options in the AI panel.
2. Add command palette entries only for high-value workflows.
3. Show the active workflow, current phase, and verification status in the chat UI.
4. Keep free-form chat available; workflows should guide, not replace it.

## Phase 4: Verification and Rollback

1. Require every write workflow to produce a file change summary.
2. For multi-file workflows, require a pre-write plan or blueprint.
3. Integrate existing diff summary behavior as the workflow completion screen.
4. Make verification failures visible and actionable.

## Phase 5: Tests

1. Unit test workflow registry loading.
2. Unit test tool policy derivation for each workflow.
3. Add runner tests that a workflow injects the expected prompt constraints.
4. Add safety tests for write workflows.

## Acceptance Criteria

- Users can start a diagnostic fix workflow without manually explaining the process.
- The runner can identify the active workflow and enforce its allowed tool policy.
- Workflow phases are visible in the chat panel.
- Write workflows end with a diff summary and verification state.
- Existing free-form Build, Plan, Review, and Explore modes continue to work.

## Risks

- Too many workflows could make the UI feel heavy.
- Overly strict tool policies may block useful agent recovery behavior.
- Workflow state should not become a second orchestration engine; it should guide the existing runner.

## Suggested First PR

Implement the workflow registry and Diagnostic Fix workflow metadata, then thread `workflowId` through the runner without changing default chat behavior.
