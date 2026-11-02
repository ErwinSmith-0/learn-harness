import { AgentState } from "./agentState";

export function buildContext(state: AgentState): string {
    const findings = state.findings.length
        ? state.findings.map((finding, index) => {
            const evidence = finding.evidence
                .map(e => `- ${e.file}${e.lines ? `:${e.lines}` : ""}`)
                .join("\n");

            return `${index + 1}. ${finding.claim}\nEvidence:\n${evidence}`;
        }).join("\n\n")
        : "No findings yet.";

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

CURRENT FINDINGS:
${findings}

RECENT TOOL RESULTS:
${recentResults || "None"}
`;
}
