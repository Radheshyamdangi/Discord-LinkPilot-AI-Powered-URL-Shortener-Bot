import mongoose from "mongoose";

const urlSchema = new mongoose.Schema({
    shortId: {
        type: String,
        required: true,
        unique: true
    },
    redirectURL: {
        type: String,
        required: true
    },
    createdByUserId: {
        type: String,
        required: true
    },
    createdByUsername: {
        type: String,
        required: true
    },
    visitHistory: [{ timestamp: { type: Number } }]
}, {
    timestamps: true
});

export default mongoose.model("discordURL", urlSchema);
