
export type Finding = {
    claim: string;

    evidence: {
        file: string;
        lines?: string;
    }[];
};

export type AgentState = {
    task: string;

    findings: Finding[];

    inspectedFiles: string[];

    recentToolResults: {
        tool: string;
        result: unknown;
    }[];

    iteration: number;
};
