import fs from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(
    process.env.CODEBASE_PATH ?? "./sample-repo",
);

const MAX_FILE_SIZE = 50_000;
const MAX_LINES = 400;

export async function readFile(filePath: string) {
    const absolutePath = path.resolve(ROOT, filePath);

    // Security boundary:
    // Make sure the resolved path stays inside ROOT.
    const relativePath = path.relative(ROOT, absolutePath);

    if (
        relativePath.startsWith("..") ||
        path.isAbsolute(relativePath)
    ) {
        throw new Error("Access denied: file is outside repository");
    }

    const stats = await fs.stat(absolutePath);

    if (!stats.isFile()) {
        throw new Error("Path is not a file");
    }

    if (stats.size > MAX_FILE_SIZE) {
        throw new Error("File is too large to read");
    }

    const content = await fs.readFile(
        absolutePath,
        "utf8",
    );

    const lines = content.split("\n");

    return {
        path: relativePath,
        content: lines.slice(0, MAX_LINES).join("\n"),
        truncated: lines.length > MAX_LINES,
    };
}