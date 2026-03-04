import axios from "axios";

const API_KEY = "AIzaSyCxpPcA-ZA983Yuv8_ADNMrN4TK9Gl5JMo";

async function run() {
    try {
        const response = await axios.get(`https://generativelanguage.googleapis.com/v1beta/models?key=${API_KEY}`);
        const models = response.data.models;
        console.log("AVAILABLE MODELS:");
        models.forEach(m => console.log(m.name));
    } catch (e) {
        console.log("Error fetching models:", e.message);
        if (e.response && e.response.data) {
            console.log(JSON.stringify(e.response.data, null, 2));
        }
    }
}
run();
