import { GoogleGenAI, Type } from "@google/genai";
import "dotenv/config";
import { z } from "zod";

// Initialize the Google Gen AI client
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Define Zod schema for runtime validation
const UserSchema = z.object({
    name: z.string(),
    age: z.number(),
    role: z.string(),
});

async function main() {
    const prompt = `
    Extract the user information.

    My name is Shayan, I am 25 years old,
    and I work as a software engineer.
  `;

    // Request structured JSON output using Gemini 2.5 Flash
    const response = await ai.models.generateContent({
        model: "gemini-3.5-flash-lite",
        contents: prompt,
        config: {
            responseMimeType: "application/json",
            responseSchema: {
                type: Type.OBJECT,
                properties: {
                    name: { type: Type.STRING },
                    age: { type: Type.NUMBER },
                    role: { type: Type.STRING },
                },
                required: ["name", "age", "role"],
            },
        },
    });

    // Ensure response text exists before parsing
    if (!response.text) {
        throw new Error("No response returned from Gemini API.");
    }

    // Parse and validate with Zod
    const user = UserSchema.parse(JSON.parse(response.text));

    console.log(user);
}

main().catch(console.error);