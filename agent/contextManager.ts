
import { AgentState } from "./agentState";

export function buildContext(state: AgentState): string {
    // Include validated findings and their actual source evidence.
    const findings = state.findings.length
        ? state.findings.map((finding, index) => {
            const evidence = finding.evidence
                .map(e => `
  File: ${e.file}
  Lines: ${e.lines}
  Source excerpt:
  ${e.excerpt}
`)
                .join("\n");

            return `
Finding ${index + 1}:
Claim: ${finding.claim}

Supporting evidence:
${evidence}
`;
        }).join("\n")
        : "No validated findings yet.";

    // Keep only the recent tool results maintained by AgentState.
    const recentResults = state.recentToolResults
        .map(item => JSON.stringify({
            tool: item.tool,
            result: item.result,
        }))
        .join("\n");

    return `
ORIGINAL TASK:
${state.task}

ITERATION:
${state.iteration}

FILES ALREADY INSPECTED:
${state.inspectedFiles.join("\n") || "None"}

VALIDATED FINDINGS:
${findings}

RECENT TOOL RESULTS:
${recentResults || "None"}
`;
}
