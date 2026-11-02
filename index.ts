
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

async function executeTool(
    name: string,
    args: Record<string, unknown>,
    state: AgentState
): Promise<unknown> {
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

        if (!state.inspectedFiles.includes(path)) {
            state.inspectedFiles.push(path);
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

1. Start with search_code to locate relevant files and symbols.
2. When search_code identifies a potentially relevant file,
   use read_file to inspect the actual implementation.
3. Do not repeatedly search for different variations of the same
   query when you already have a relevant file path.
4. Follow the evidence. If the first file does not explain the
   issue, investigate related files.
5. Keep track of what you have already inspected.
6. Stop investigating once you have enough evidence to explain
   the issue.
7. If evidence is insufficient, clearly explain what is missing.
8. Never claim that you changed code.
9. Never modify files.

Available tools:

- search_code: Find relevant files and lines.
- read_file: Inspect the actual contents of a specific file.

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

        // Add tool results to the manually managed history.
        history.push({
            role: "user",
            parts: functionResponseParts,
        });

        // Ask Gemini to continue using the updated history.
        response = await ai.models.generateContent({
            model,
            contents: history,
            config,
        });
    }

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
