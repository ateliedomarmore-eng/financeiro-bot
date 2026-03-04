import { GoogleGenerativeAI } from "@google/generative-ai";
const genAI = new GoogleGenerativeAI("AIzaSyCxpPcA-ZA983Yuv8_ADNMrN4TK9Gl5JMo");
const testModels = ["gemini-1.5-flash", "gemini-1.5-pro", "gemini-1.0-pro"];

async function run() {
    for (const m of testModels) {
        try {
            console.log("Testing:", m);
            const model = genAI.getGenerativeModel({ model: m });
            const result = await model.generateContent("hello");
            console.log("Success:", m, result.response.text());
        } catch (e) {
            console.log("Error for", m, e.message);
        }
    }
}
run();
