
import type { Content } from "@google/genai";
import type { AgentState } from "./agentState";
import { buildContext } from "./contextManager";

export function compactHistory(state: AgentState): Content[] {
    const context = buildContext(state);

    return [
        {
            role: "user",
            parts: [
                {
                    text: `
The conversation history has been compacted.

You are continuing the same code investigation.
Use the following investigation state as your working context.

${context}

Continue investigating from where you left off.
Do not repeat searches or file inspections unnecessarily.
Use the available tools if additional evidence is required.
                    `.trim(),
                },
            ],
        },
    ];
}
