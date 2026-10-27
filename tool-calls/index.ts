
import fs from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(process.env.CODEBASE_PATH ?? "../sample-repo");

const ALLOWED_EXTENSIONS = new Set([
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
]);

const IGNORED_DIRECTORIES = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    ".next",
]);

export async function searchCode(query: string) {
    if (!query.trim()) {
        throw new Error("Search query cannot be empty");
    }

    const results: {
        file: string;
        line: number;
        text: string;
    }[] = [];

    async function walk(directory: string): Promise<void> {
        const entries = await fs.readdir(directory, {
            withFileTypes: true,
        });

        for (const entry of entries) {
            if (results.length >= 50) return;

            const fullPath = path.join(directory, entry.name);

            if (entry.isDirectory()) {
                if (!IGNORED_DIRECTORIES.has(entry.name)) {
                    await walk(fullPath);
                }

                continue;
            }

            if (!ALLOWED_EXTENSIONS.has(path.extname(entry.name))) {
                continue;
            }

            const content = await fs.readFile(fullPath, "utf8");
            const lines = content.split("\n");

            lines.forEach((line, index) => {
                if (
                    results.length < 50 &&
                    line.toLowerCase().includes(query.toLowerCase())
                ) {
                    results.push({
                        file: path.relative(ROOT, fullPath),
                        line: index + 1,
                        text: line.trim().slice(0, 300),
                    });
                }
            });
        }
    }

    await walk(ROOT);
    return results;
}
