import "dotenv/config";
import { searchCode } from "./tool-calls/tools/searchCode";
import { readFile } from "./tool-calls/tools/readFile";
import { GoogleGenAI, FunctionDeclaration, Type } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const model = "gemini-3.5-flash-lite";

const searchCodeDeclaration: FunctionDeclaration = {
    name: "search_code",
    description: "Search source-code files in the approved repository for a literal text query.",
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

    const chat = ai.chats.create({
        model: model,
        config: {
            systemInstruction: systemInstruction,
            tools: [{ functionDeclarations: [searchCodeDeclaration, readFileDeclaration] }]
        },
    });

    let response = await chat.sendMessage({ message: question });

    const MAX_ITERATIONS = 20;

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
        const functionCalls = response.functionCalls;

        if (!functionCalls || functionCalls.length === 0) {
            console.log(response.text);
            return;
        }

        const functionResponses = [];

        for (const call of functionCalls) {
            try {
                // -------------------------
                // search_code
                // -------------------------
                if (call.name === "search_code") {
                    const args = call.args as { query?: string };

                    if (
                        !args ||
                        typeof args.query !== "string" ||
                        args.query.trim().length === 0 ||
                        args.query.length > 100
                    ) {
                        throw new Error("Invalid search arguments");
                    }

                    console.log(
                        `Tool requested: search_code("${args.query}")`
                    );

                    const result = await searchCode(args.query);

                    functionResponses.push({
                        functionResponse: {
                            name: "search_code",
                            response: { result },
                        },
                    });

                    continue;
                }

                // -------------------------
                // read_file
                // -------------------------
                if (call.name === "read_file") {
                    const args = call.args as { path?: string };

                    if (
                        !args ||
                        typeof args.path !== "string" ||
                        args.path.trim().length === 0 ||
                        args.path.length > 300
                    ) {
                        throw new Error("Invalid read_file arguments");
                    }

                    console.log(
                        `Tool requested: read_file("${args.path}")`
                    );

                    const result = await readFile(args.path);

                    functionResponses.push({
                        functionResponse: {
                            name: "read_file",
                            response: { result },
                        },
                    });

                    continue;
                }

                // -------------------------
                // Unknown tool
                // -------------------------
                functionResponses.push({
                    functionResponse: {
                        name: call.name,
                        response: {
                            error: "Tool is not allowed",
                        },
                    },
                });

            } catch (error) {
                functionResponses.push({
                    functionResponse: {
                        name: call.name,
                        response: {
                            error:
                                error instanceof Error
                                    ? error.message
                                    : "Tool execution failed",
                        },
                    },
                });
            }
        }

        response = await chat.sendMessage({ message: functionResponses });
    }

    console.log(
        "Stopped: maximum tool iterations reached. " +
        "The investigation may be incomplete.",
    );
}

main().catch((error) => {
    console.error("Agent failed:", error);
    process.exitCode = 1;
});
