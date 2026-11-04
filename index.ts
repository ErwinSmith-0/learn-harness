import "dotenv/config";

import {
    GoogleGenAI,
    FunctionDeclaration,
    Type,
    type Content,
} from "@google/genai";

import { searchCode } from "./tool-calls/tools/searchCode";
import { readFile } from "./tool-calls/tools/readFile-v2";
import { compactHistory } from "./agent/historyManager";
import { buildContext } from "./agent/contextManager";
import { addValidatedFinding } from "./agent/findingValidator";
import type { AgentState, Finding } from "./agent/agentState";

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
    throw new Error("GEMINI_API_KEY is missing from environment variables.");
}

const ai = new GoogleGenAI({ apiKey });

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
                description: "Text to search for, such as cookie or logout.",
            },
        },
        required: ["query"],
    },
};

const readFileDeclaration: FunctionDeclaration = {
    name: "read_file",
    description:
        "Read a relevant source file identified by search_code. Use numberedContent " +
        "to identify exact line numbers. Do not repeatedly search when you already " +
        "know the relevant file path.",
    parameters: {
        type: Type.OBJECT,
        properties: {
            path: {
                type: Type.STRING,
                description: "Repository-relative path of the file to read.",
            },
        },
        required: ["path"],
    },
};

const submitFindingDeclaration: FunctionDeclaration = {
    name: "submit_finding",
    description:
        "Submit a finding supported by exact source-code evidence from files already read.",
    parameters: {
        type: Type.OBJECT,
        properties: {
            claim: {
                type: Type.STRING,
                description: "A precise conclusion supported by the evidence.",
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
                            description: "Line range, for example 8-12.",
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
        "Finish the investigation after sufficient evidence has been collected and validated.",
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

type ToolCall = NonNullable<
    Awaited<ReturnType<typeof ai.models.generateContent>>["functionCalls"]
>[number];

type ToolOutcome = {
    call: ToolCall;
    response: unknown;
};

/**
 * Executes a tool and returns its result.
 *
 * search_code and read_file do not mutate AgentState here.
 * State updates are handled centrally by recordToolResult().
 *
 * submit_finding and finish_investigation remain stateful and are only
 * executed through the sequential path.
 */
async function executeTool(
    name: string,
    args: Record<string, unknown>,
    state: AgentState
): Promise<unknown> {
    if (state.completed) {
        throw new Error("The investigation is already complete.");
    }

    if (name === "search_code") {
        const query = args.query;

        if (
            typeof query !== "string" ||
            query.trim().length === 0 ||
            query.length > 100
        ) {
            throw new Error("Invalid search_code arguments.");
        }

        console.log(`Tool requested: search_code("${query}")`);
        return await searchCode(query);
    }

    if (name === "read_file") {
        const filePath = args.path;

        if (
            typeof filePath !== "string" ||
            filePath.trim().length === 0 ||
            filePath.length > 300
        ) {
            throw new Error("Invalid read_file arguments.");
        }

        console.log(`Tool requested: read_file("${filePath}")`);
        return await readFile(filePath);
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

    if (name === "finish_investigation") {
        if (state.findings.length === 0) {
            throw new Error(
                "Cannot finish: no validated findings have been submitted."
            );
        }

        const reason = args.reason;

        if (typeof reason !== "string" || reason.trim().length === 0) {
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

    throw new Error(`Tool "${name}" is not allowed.`);
}

/**
 * Centralized state update.
 *
 * This is called after tool execution has completed. In parallel batches,
 * outcomes are processed in the original function-call order.
 */
function recordToolResult(
    name: string,
    result: unknown,
    state: AgentState
): void {
    if (name === "read_file") {
        const fileResult = result as { path?: unknown };

        if (
            typeof fileResult.path === "string" &&
            !state.inspectedFiles.includes(fileResult.path)
        ) {
            state.inspectedFiles.push(fileResult.path);
        }
    }

    if (name === "search_code" || name === "read_file") {
        state.recentToolResults.push({
            tool: name,
            result,
        });

        if (state.recentToolResults.length > MAX_RECENT_RESULTS) {
            state.recentToolResults =
                state.recentToolResults.slice(-MAX_RECENT_RESULTS);
        }
    }
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

async function runToolCalls(
    functionCalls: ToolCall[],
    state: AgentState
): Promise<ToolOutcome[]> {
    const canRunInParallel =
        functionCalls.length > 1 &&
        functionCalls.every((call) => call.name === "search_code");

    if (canRunInParallel) {
        console.log(
            "\n[Tool Executor] Running independent searches in parallel...\n"
        );

        const settledResults = await Promise.allSettled(
            functionCalls.map((call) =>
                executeTool(
                    call.name ?? "",
                    (call.args ?? {}) as Record<string, unknown>,
                    state
                )
            )
        );

        // Promise.allSettled preserves input order. Apply state updates
        // centrally and in that same order.
        return settledResults.map((outcome, index) => {
            const call = functionCalls[index];

            if (outcome.status === "fulfilled") {
                recordToolResult(call.name ?? "", outcome.value, state);

                return {
                    call,
                    response: outcome.value,
                };
            }

            return {
                call,
                response: {
                    success: false,
                    error: getErrorMessage(outcome.reason),
                },
            };
        });
    }

    console.log("\n[Tool Executor] Running tools sequentially...\n");

    const outcomes: ToolOutcome[] = [];

    for (const call of functionCalls) {
        try {
            const result = await executeTool(
                call.name ?? "",
                (call.args ?? {}) as Record<string, unknown>,
                state
            );

            recordToolResult(call.name ?? "", result, state);

            outcomes.push({
                call,
                response: result,
            });
        } catch (error) {
            const message = getErrorMessage(error);

            console.error(`Tool ${call.name} failed:`, message);

            outcomes.push({
                call,
                response: {
                    success: false,
                    error: message,
                },
            });
        }
    }

    return outcomes;
}

/**
 * Gemini requires functionResponse.response to be a JSON object (map),
 * not a bare array or primitive. search_code returns an array, so wrap it.
 */
function toFunctionResponsePayload(
    response: unknown
): Record<string, unknown> {
    if (
        response !== null &&
        typeof response === "object" &&
        !Array.isArray(response)
    ) {
        return response as Record<string, unknown>;
    }

    return { result: response };
}

function toFunctionResponseParts(
    outcomes: ToolOutcome[]
): NonNullable<Content["parts"]> {
    return outcomes.map(({ call, response }) => ({
        functionResponse: {
            name: call.name ?? "",
            ...(call.id ? { id: call.id } : {}),
            response: toFunctionResponsePayload(response),
        },
    }));
}

async function main(): Promise<void> {
    const question =
        process.argv.slice(2).join(" ") ||
        "Investigate why logout might not clear the authentication cookie.";

    const systemInstruction = `
You are a code investigation agent.

Your goal is to investigate the user's issue using the available
repository tools and provide an evidence-based explanation.

FINDING RULES:

1. Use search_code to locate relevant code.
2. Use read_file to inspect relevant source code.
3. Use numberedContent to identify exact source line numbers.
4. Once you have sufficient evidence, call submit_finding.
5. Include the exact source excerpt and its line range.
6. Never invent line numbers or source excerpts.
7. If submit_finding rejects your evidence, correct it or investigate further.
8. Do not repeat searches or file inspections unnecessarily.

AVAILABLE TOOLS:

- search_code: Find relevant files and lines.
- read_file: Inspect the actual contents of a specific file.
- submit_finding: Submit evidence-backed findings for validation.
- finish_investigation: Mark the investigation complete.

COMPLETION RULES:

1. Do not finish without sufficient evidence.
2. Submit relevant findings using submit_finding.
3. Once validated findings sufficiently answer the original task,
   call finish_investigation.
4. Do not continue searching after the investigation is complete.
5. If evidence is insufficient, continue investigating.

IMPORTANT:
A search result alone is not enough to conclude that a file contains
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
                    finishInvestigationDeclaration,
                ],
            },
        ],
    };

    let response = await ai.models.generateContent({
        model,
        contents: history,
        config,
    });

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
        state.iteration = iteration + 1;

        // Preserve the model response, including its function-call parts.
        const modelContent = response.candidates?.[0]?.content;

        if (modelContent) {
            history.push(modelContent);
        }

        const functionCalls = response.functionCalls ?? [];

        // No tool calls: the model stopped. Only accept this as a final
        // answer if the harness has explicitly marked the task complete.
        if (functionCalls.length === 0) {
            console.log("\n========== AGENT CONTEXT ==========\n");
            console.log(buildContext(state));

            if (!state.completed) {
                console.log("\n========== INCOMPLETE INVESTIGATION ==========\n");
                console.log(
                    response.text ??
                    "The agent stopped without providing a final response."
                );
                console.log(
                    "\nStopped: the agent did not explicitly complete the investigation."
                );
                return;
            }

            console.log("\n========== FINAL ANSWER ==========\n");
            console.log(response.text);
            return;
        }

        const outcomes = await runToolCalls(functionCalls, state);
        const functionResponseParts = toFunctionResponseParts(outcomes);

        // Function responses are sent back as a user-role content item.
        history.push({
            role: "user",
            parts: functionResponseParts,
        });

        // Once finish_investigation succeeds, request a final answer without
        // exposing tools to the model again.
        if (state.completed) {
            console.log("\n[Agent] Switching to final-answer mode...");

            const finalResponse = await ai.models.generateContent({
                model,
                contents: [
                    ...history,
                    {
                        role: "user",
                        parts: [
                            {
                                text: `
Validated investigation state:

${buildContext(state)}

Completion reason:
${state.completionReason}

Write the final answer using only the validated evidence above.
Include file paths and line numbers where available.
Distinguish confirmed findings from assumptions.
Do not request or execute additional tools.
                                `.trim(),
                            },
                        ],
                    },
                ],
                config: {
                    systemInstruction: `
You are in final-answer mode.
The harness has explicitly marked the investigation complete.
Explain the findings clearly and accurately.
Do not invent evidence or claim more than the source proves.
Do not call tools.
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

        // Compact only after the complete tool-response cycle.
        if (history.length >= MAX_HISTORY_MESSAGES) {
            console.log(
                "\n[Context Manager] Compacting conversation history...\n"
            );

            history = compactHistory(state);

            console.log(
                `[Context Manager] History reduced to ${history.length} message(s).`
            );
        }

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

    console.log(
        "\nStopped: maximum tool iterations reached. " +
        "The investigation may be incomplete."
    );
}

main().catch((error) => {
    console.error("Agent failed:", error);
    process.exitCode = 1;
});
