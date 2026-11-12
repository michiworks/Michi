import { beginSse } from "../services/httpSse";
import express from "express";
import { ChatManager } from "../services/chatManager";
import {
    streamDigestGeneration,
    GenerationRequest,
} from "../services/digestGenerator";
import { workspaceCwdError } from "../services/workspaceCwd";
import { ownedSandboxCwd } from "../services/workspaceSandbox";
import { requireWorkspaceOwner } from "./middleware/ownership";

export function setupDigestRoutes(chatManager: ChatManager) {
    const router = express.Router();

    router.post("/digests/stream", requireWorkspaceOwner, async (req, res) => {
        const body = req.body as GenerationRequest;
        if (!body || !Array.isArray(body.nodes) || body.nodes.length === 0) {
            return res.status(400).json({ error: "nodes is required" });
        }
        let cwd = body.cwd;
        if (process.env.MICHI_CLOUD === "1") {
            // requireWorkspaceOwner checked body.workspaceId; the digest runs in its sandbox, not a folder the body names.
            const owned = ownedSandboxCwd(req.user!.id, req.body.workspaceId);
            if ("error" in owned) return res.status(owned.status).json({ error: owned.error });
            cwd = owned.cwd;
        } else if (cwd !== undefined) {
            const invalid = workspaceCwdError(cwd);
            if (invalid) return res.status(400).json(invalid);
        }

        const observer = beginSse(res);
        const send = (event: string, data: unknown) => {
            observer.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };

        try {
            for await (const ev of streamDigestGeneration(chatManager, { ...body, cwd })) {
                // Drain the producer after observer disconnect; do not cancel its turn.
                if (ev.kind === "chunk" || ev.kind === "thought" || ev.kind === "status") {
                    send(ev.kind, { text: ev.text });
                } else if (ev.kind === "done") {
                    send("done", { markdown: ev.finalMarkdown });
                    break;
                }
            }
        } catch (err) {
            console.error("Digest streaming failed:", err);
            send("error", { message: (err as Error).message });
        } finally {
            observer.close();
            if (!res.destroyed && !res.writableEnded) res.end();
        }
    });

    return router;
}
