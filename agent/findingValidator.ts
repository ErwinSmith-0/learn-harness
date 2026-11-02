
import path from "node:path";
import type { Finding, AgentState } from "./agentState";
import { readFile } from "../tool-calls/tools/readFile-v2";

export async function validateFinding(
    finding: Finding,
    state: AgentState
): Promise<Finding> {
    // 1. Validate the claim.
    if (
        typeof finding.claim !== "string" ||
        finding.claim.trim().length === 0
    ) {
        throw new Error("Finding must contain a valid claim");
    }

    // 2. Validate evidence.
    if (
        !Array.isArray(finding.evidence) ||
        finding.evidence.length === 0
    ) {
        throw new Error("Finding must contain supporting evidence");
    }

    const validatedEvidence: Finding["evidence"] = [];

    for (const evidence of finding.evidence) {
        if (
            typeof evidence.file !== "string" ||
            typeof evidence.lines !== "string" ||
            typeof evidence.excerpt !== "string"
        ) {
            throw new Error("Invalid evidence structure");
        }

        // 3. Check that the file was actually inspected.
        const normalizedPath = path.normalize(evidence.file);

        const wasInspected = state.inspectedFiles.some(
            (file) => path.normalize(file) === normalizedPath
        );

        if (!wasInspected) {
            throw new Error(
                `File was not inspected: ${evidence.file}`
            );
        }

        // 4. Parse line range: "7" or "7-9".
        const match = evidence.lines.match(/^(\d+)(?:-(\d+))?$/);

        if (!match) {
            throw new Error("Invalid evidence line range");
        }

        const startLine = Number(match[1]);
        const endLine = Number(match[2] ?? match[1]);

        if (
            startLine < 1 ||
            endLine < startLine ||
            endLine - startLine > 30
        ) {
            throw new Error("Evidence line range is invalid or too large");
        }

        // 5. Re-read the actual file.
        const file = await readFile(evidence.file);

        const actualLines = file.content.split(/\r?\n/);

        if (endLine > actualLines.length) {
            throw new Error(
                `Evidence references unavailable lines: ${evidence.lines}`
            );
        }

        // 6. Extract the actual source excerpt.
        const actualExcerpt = actualLines
            .slice(startLine - 1, endLine)
            .join("\n");

        // 7. Compare the proposed excerpt with the actual source.
        const normalizeText = (value: string) =>
            value.replace(/\r\n/g, "\n").trim();

        if (
            normalizeText(evidence.excerpt) !==
            normalizeText(actualExcerpt)
        ) {
            throw new Error(
                `Evidence excerpt does not match ${evidence.file}:${evidence.lines}`
            );
        }

        // Store the actual source, not the model's copied excerpt.
        validatedEvidence.push({
            file: file.path,
            lines: `${startLine}-${endLine}`,
            excerpt: actualExcerpt,
        });
    }

    return {
        claim: finding.claim.trim(),
        evidence: validatedEvidence,
    };
}


export async function addValidatedFinding(
    finding: Finding,
    state: AgentState
): Promise<void> {
    const validated = await validateFinding(finding, state);

    // Avoid storing duplicate claims with the same evidence.
    const duplicate = state.findings.some(
        (existing) =>
            existing.claim === validated.claim &&
            JSON.stringify(existing.evidence) ===
            JSON.stringify(validated.evidence)
    );

    if (!duplicate) {
        state.findings.push(validated);
    }
}
