import "dotenv/config";
import { searchCode } from "../tools/searchCode";
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

async function main() {
    const question =
        process.argv.slice(2).join(" ") ||
        "Investigate why logout might not clear the authentication cookie.";

    const systemInstruction = `
      You are a code investigation agent.
      Use search_code when repository evidence is needed.
      Base conclusions on tool results.
      If the evidence is insufficient, say what is missing.
      Do not claim you changed any code.
    `;

    const chat = ai.chats.create({
        model: model,
        config: {
            systemInstruction: systemInstruction,
            tools: [{ functionDeclarations: [searchCodeDeclaration] }],
        },
    });

    let response = await chat.sendMessage({ message: question });

    const MAX_ITERATIONS = 6;

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
        const functionCalls = response.functionCalls;

        if (!functionCalls || functionCalls.length === 0) {
            console.log(response.text);
            return;
        }

        const functionResponses = [];

        for (const call of functionCalls) {
            if (call.name !== "search_code") {
                functionResponses.push({
                    functionResponse: {
                        name: call.name,
                        response: { error: "Tool is not allowed" },
                    },
                });
                continue;
            }

            try {
                const args = call.args as { query?: string };

                if (
                    !args ||
                    typeof args.query !== "string" ||
                    args.query.trim().length === 0 ||
                    args.query.length > 100
                ) {
                    throw new Error("Invalid search arguments");
                }

                console.log(`Tool requested: search_code("${args.query}")`);

                const result = await searchCode(args.query);

                functionResponses.push({
                    functionResponse: {
                        name: "search_code",
                        response: { result },
                    },
                });
            } catch (error) {
                functionResponses.push({
                    functionResponse: {
                        name: "search_code",
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
