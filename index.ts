
import "dotenv/config";

import { searchCode } from "./tool-calls/tools/searchCode";
import { readFile } from "./tool-calls/tools/readFile-v2";
import { AgentState } from "./agent/agentState";
import { compactHistory } from "./agent/historyManager";
import {
    GoogleGenAI,
    FunctionDeclaration,
    Type,
    type Content,
} from "@google/genai";
import { buildContext } from "./agent/contextManager";
import { addValidatedFinding } from "./agent/findingValidator";
import type { Finding } from "./agent/agentState";

const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
});

const model = "gemini-3.5-flash-lite";

const MAX_ITERATIONS = 6;
const MAX_RECENT_RESULTS = 5;
const MAX_HISTORY_MESSAGES = 9;

const searchCodeDeclaration: FunctionDeclaration = {
    name: "search_code",
    description:
        "Search source-code files in the approved repository for a literal text query.",
    parameters: {
        type: Type.OBJECT,
        properties: {
            query: {
                type: Type.STRING,
                description: "Text to search for, such as cookie or logout",
            },
        },
        required: ["query"],
    },
};

const readFileDeclaration: FunctionDeclaration = {
    name: "read_file",
    description:
        "Read the actual source code of a specific file after search_code " +
        "has identified it as relevant. Use this to inspect the implementation " +
        "and understand how the code works. Do not use search_code repeatedly " +
        "when you already know the relevant file path.",
    parameters: {
        type: Type.OBJECT,
        properties: {
            path: {
                type: Type.STRING,
                description: "Repository-relative path of the file to read",
            },
        },
        required: ["path"],
    },
};

const submitFindingDeclaration: FunctionDeclaration = {
    name: "submit_finding",
    description:
        "Submit a finding supported by exact source-code evidence. Only submit findings from files already inspected using read_file.",

    parameters: {
        type: Type.OBJECT,
        properties: {
            claim: {
                type: Type.STRING,
                description: "The conclusion or discovery from the investigation.",
            },
            evidence: {
                type: Type.ARRAY,
                description: "Exact source-code evidence supporting the claim.",
                items: {
                    type: Type.OBJECT,
                    properties: {
                        file: {
                            type: Type.STRING,
                            description: "Repository-relative file path.",
                        },
                        lines: {
                            type: Type.STRING,
                            description: "Line range, e.g. 8-12.",
                        },
                        excerpt: {
                            type: Type.STRING,
                            description: "Exact source code copied from those lines.",
                        },
                    },
                    required: ["file", "lines", "excerpt"],
                },
            },
        },
        required: ["claim", "evidence"],
    },
};

const finishInvestigationDeclaration: FunctionDeclaration = {
    name: "finish_investigation",
    description:
        "Finish the investigation when sufficient evidence has been collected and validated.",

    parameters: {
        type: Type.OBJECT,
        properties: {
            reason: {
                type: Type.STRING,
                description: "Explain why the investigation is complete.",
            },
        },
        required: ["reason"],
    },
};

async function executeTool(
    name: string,
    args: Record<string, unknown>,
    state: AgentState
): Promise<unknown> {

    if (name === "finish_investigation") {
        if (state.completed) {
            throw new Error("Investigation is already complete.");
        }

        if (state.findings.length === 0) {
            throw new Error(
                "Cannot finish: no validated findings have been submitted."
            );
        }

        const reason = args.reason;

        if (
            typeof reason !== "string" ||
            reason.trim().length === 0
        ) {
            throw new Error("A valid completion reason is required.");
        }

        state.completed = true;
        state.completionReason = reason.trim();

        console.log("\n[Agent] Investigation completed.");
        console.log(`[Agent] Reason: ${state.completionReason}`);

        return {
            success: true,
            message: "Investigation marked as complete.",
        };
    }
    if (name === "submit_finding") {
        const finding = args as unknown as Finding;
        console.log(`Tool requested: submit_finding("${finding.claim}")`);
        await addValidatedFinding(finding, state);
        console.log("Finding successfully validated and stored.");

        return {
            success: true,
            message: "Finding successfully validated and stored.",
        };
    }
    if (name === "search_code") {
        const query = args.query;

        if (
            typeof query !== "string" ||
            query.trim().length === 0 ||
            query.length > 100
        ) {
            throw new Error("Invalid search arguments");
        }

        console.log(`Tool requested: search_code("${query}")`);

        const result = await searchCode(query);

        state.recentToolResults.push({
            tool: name,
            result,
        });

        if (state.recentToolResults.length > MAX_RECENT_RESULTS) {
            state.recentToolResults =
                state.recentToolResults.slice(-MAX_RECENT_RESULTS);
        }

        return result;
    }

    if (name === "read_file") {
        const path = args.path;

        if (
            typeof path !== "string" ||
            path.trim().length === 0 ||
            path.length > 300
        ) {
            throw new Error("Invalid read_file arguments");
        }

        console.log(`Tool requested: read_file("${path}")`);

        const result = await readFile(path);

        if (!state.inspectedFiles.includes(result.path)) {
            state.inspectedFiles.push(result.path);
        }

        state.recentToolResults.push({
            tool: name,
            result,
        });

        if (state.recentToolResults.length > MAX_RECENT_RESULTS) {
            state.recentToolResults =
                state.recentToolResults.slice(-MAX_RECENT_RESULTS);
        }

        return result;
    }

    throw new Error(`Tool "${name}" is not allowed`);
}

async function main() {
    const question =
        process.argv.slice(2).join(" ") ||
        "Investigate why logout might not clear the authentication cookie.";

    const systemInstruction = `
You are a code investigation agent.

Your goal is to investigate the user's issue using the available
repository tools and provide an evidence-based explanation.

Investigation strategy:

FINDING RULES:

1. Use search_code to locate relevant code.
2. Use read_file to inspect the complete relevant source.
3. Use numberedContent to identify exact source line numbers.
4. Once you have sufficient evidence, call submit_finding.
5. Include the exact source excerpt and its line range.
6. Never invent line numbers or source excerpts.
7. If submit_finding rejects your evidence, correct it or investigate further.
8. Once a finding is successfully submitted and it answers the task,
   provide your final explanation instead of repeating searches.

Available tools:

- search_code: Find relevant files and lines.
- read_file: Inspect the actual contents of a specific file.
- submit_finding: Submit evidence-backed findings for validation.
- finish_investigation: Mark the investigation complete when sufficient evidence exists.

COMPLETION RULES:

1. Do not finish an investigation without sufficient evidence.
2. Submit relevant findings using submit_finding.
3. Once the validated findings sufficiently answer the original task,
   call finish_investigation.
4. Do not continue searching after the investigation is complete.
5. If evidence is insufficient, continue investigating.

Important:
A search result is not enough to conclude that a file contains
the bug. Read the relevant file before drawing conclusions.
`;

    const state: AgentState = {
        task: question,
        findings: [],
        inspectedFiles: [],
        recentToolResults: [],
        iteration: 0,
        completed: false,
        completionReason: undefined,
    };

    // The harness now owns the conversation history.
    let history: Content[] = [
        {
            role: "user",
            parts: [{ text: question }],
        },
    ];

    const config = {
        systemInstruction,
        tools: [
            {
                functionDeclarations: [
                    searchCodeDeclaration,
                    readFileDeclaration,
                    submitFindingDeclaration,
                    finishInvestigationDeclaration
                ],
            },
        ],
    };



    // First model request.
    let response = await ai.models.generateContent({
        model,
        contents: history,
        config,
    });

    // Agent execution loop.
    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
        state.iteration = iteration + 1;

        // Preserve the complete model response, including function calls.
        const modelContent = response.candidates?.[0]?.content;

        if (modelContent) {
            history.push(modelContent);
            if (history.length >= MAX_HISTORY_MESSAGES) {
                console.log("\n[Context Manager] Compacting conversation history...\n");

                history = compactHistory(state);

                console.log(
                    `[Context Manager] History reduced to ${history.length} message(s).`
                );
            }
        }

        const functionCalls = response.functionCalls ?? [];

        // The model has finished its investigation.
        if (functionCalls.length === 0) {
            console.log("\n========== AGENT CONTEXT ==========\n");
            console.log(buildContext(state));

            console.log("\n========== FINAL ANSWER ==========\n");
            console.log(response.text);

            return;
        }

        // Collect all tool responses from this model turn.
        const functionResponseParts: NonNullable<Content["parts"]> = [];

        for (const call of functionCalls) {
            try {
                const result = await executeTool(
                    call.name ?? "",
                    (call.args ?? {}) as Record<string, unknown>,
                    state
                );

                functionResponseParts.push({
                    functionResponse: {
                        name: call.name,
                        ...(call.id ? { id: call.id } : {}),
                        response: { result },
                    },
                });
            } catch (error) {
                const errorMessage =
                    error instanceof Error
                        ? error.message
                        : "Tool execution failed";

                console.error(
                    `Tool ${call.name} failed:`,
                    errorMessage
                );

                functionResponseParts.push({
                    functionResponse: {
                        name: call.name,
                        ...(call.id ? { id: call.id } : {}),
                        response: {
                            error: errorMessage,
                        },
                    },
                });
            }
        }

        // Add tool results to manually managed history.
        history.push({
            role: "user",
            parts: functionResponseParts,
        });

        // Check whether the harness marked the investigation complete.
        if (state.completed) {
            console.log("\n[Agent] Switching to final-answer mode...");

            const finalResponse = await ai.models.generateContent({
                model,
                contents: history,
                config: {
                    systemInstruction: `
You are now in final-answer mode.

The investigation has been marked complete by the harness.

Use the validated findings provided in the investigation context.
Explain the original issue clearly.
Include relevant file paths and line numbers.
Do not invent additional evidence.
Do not request or execute more tools.
Distinguish confirmed findings from assumptions.
            `.trim(),
                },
            });

            console.log("\n========== VALIDATED FINDINGS ==========\n");
            console.dir(state.findings, { depth: null });

            console.log("\n========== COMPLETION REASON ==========\n");
            console.log(state.completionReason);

            console.log("\n========== FINAL ANSWER ==========\n");
            console.log(finalResponse.text);

            return;
        }

        // Investigation is not complete. Continue the agent loop.
        response = await ai.models.generateContent({
            model,
            contents: history,
            config,
        });
    }

    console.log("\n========== VALIDATED FINDINGS ==========\n");

    console.dir(state.findings, { depth: null });
    console.log("\n========== AGENT CONTEXT ==========\n");
    console.log(buildContext(state));

    console.log("\n========== FINAL RESPONSE ==========\n");
    console.log(response.text);

    console.log(
        "\nStopped: maximum tool iterations reached. " +
        "The investigation may be incomplete."
    );
}

main().catch((error) => {
    console.error("Agent failed:", error);
    process.exitCode = 1;
});
