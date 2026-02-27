import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import discordURL from "./models/url.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function serializeEntry(entry) {
    return {
        shortId: entry.shortId,
        redirectURL: entry.redirectURL,
        createdByUserId: entry.createdByUserId || "unknown",
        createdByUsername: entry.createdByUsername || "unknown",
        createdAt: entry.createdAt || null,
        totalVisits: Array.isArray(entry.visitHistory) ? entry.visitHistory.length : 0
    };
}

function startServer(port = 8000) {
    const app = express();

    app.use(express.json());

    app.get("/", (req, res) => {
        res.sendFile(path.join(__dirname, "public", "index.html"));
    });

    app.get("/api/urls", async (req, res) => {
        try {
            const urls = await discordURL.find({}).sort({ createdAt: -1 }).lean();
            return res.json({
                total: urls.length,
                data: urls.map(serializeEntry)
            });
        } catch (error) {
            return res.status(500).json({
                error: "Failed to fetch URLs",
                details: error.message
            });
        }
    });

    app.delete("/api/urls/:shortId", async (req, res) => {
        const { shortId } = req.params;

        try {
            const deleted = await discordURL.findOneAndDelete({ shortId }).lean();
            if (!deleted) {
                return res.status(404).json({
                    error: `URL not found for shortId: ${shortId}`
                });
            }

            return res.json({
                message: "URL deleted",
                deleted: serializeEntry(deleted)
            });
        } catch (error) {
            return res.status(500).json({
                error: "Failed to delete URL",
                details: error.message
            });
        }
    });

    app.get("/:shortId", async (req, res) => {
        const shortId = req.params.shortId;

        try {
            const entry = await discordURL.findOneAndUpdate(
                { shortId },
                { $push: { visitHistory: { timestamp: Date.now() } } },
                { new: true }
            );

            if (!entry) {
                return res.status(404).send(`URL not found for shortId: ${shortId}`);
            }

            return res.redirect(entry.redirectURL);
        } catch (error) {
            return res.status(500).send("Server error");
        }
    });

    app.listen(port, () => {
        console.log(`Server is running at http://localhost:${port}`);
    });
}

export { startServer };
