import fs from "fs";
import path from "path";
import dotenv from "dotenv";

const envPath = path.resolve(process.cwd(), ".env");
const envExamplePath = path.resolve(process.cwd(), ".env.example");
const hasEnv = fs.existsSync(envPath);
const hasEnvExample = fs.existsSync(envExamplePath);

if (hasEnv) {
    dotenv.config({ path: envPath });
}

if (hasEnvExample) {
    const templateValues = dotenv.parse(fs.readFileSync(envExamplePath));
    for (const [key, value] of Object.entries(templateValues)) {
        if (!process.env[key]) {
            process.env[key] = value;
        }
    }
}

if (!hasEnv && hasEnvExample) {
    console.warn("Loaded environment from .env.example (fallback). Prefer using a real .env file.");
}
