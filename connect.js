import mongoose from "mongoose";

const mongoUri = process.env.MONGO_URI || "mongodb://localhost:27017/URL_shortner";
mongoose.set("bufferCommands", false);

async function connectDB() {
    await mongoose.connect(mongoUri, {
        serverSelectionTimeoutMS: 5000
    });
    console.log("MongoDB connected");
}

export { connectDB };
