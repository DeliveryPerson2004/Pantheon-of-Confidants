import {z} from "zod";

export interface DelegationTrace {
    traceId: string;
    path: string[];
}

const delegationTraceSchema = z.object({
    traceId: z.string().uuid(),
    path: z.array(z.string().min(1)).min(1).max(8),
});

export function parseDelegationTrace(value: unknown): DelegationTrace | undefined {
    const result = delegationTraceSchema.safeParse(value);
    return result.success ? result.data : undefined;
}
