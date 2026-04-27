require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const pdfParse = require('pdf-parse');

const app = express();
const port = process.env.PORT || 5000;

// ปรับ CORS ให้ยืดหยุ่นสำหรับ Deployment
app.use(cors());
app.use(express.json());

// สร้างโฟลเดอร์ uploads ถ้ายังไม่มี (สำหรับการทำงานชั่วคราว)
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// ตั้งค่า Multer สำหรับเก็บไฟล์ชั่วคราว
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ฟังก์ชันดึงข้อความจากไฟล์
async function extractTextFromFile(file) {
  const filePath = file.path;
  const extension = file.originalname.split('.').pop().toLowerCase();
  
  try {
    if (extension === 'pdf') {
      const dataBuffer = fs.readFileSync(filePath);
      const data = await pdfParse(dataBuffer);
      return data.text;
    } else if (extension === 'json') {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      return JSON.stringify(data);
    } else {
      return fs.readFileSync(filePath, 'utf-8');
    }
  } catch (error) {
    console.error(`Error extracting text from ${file.originalname}:`, error);
    return "";
  } finally {
    // ลบไฟล์ชั่วคราวหลังจากอ่านเสร็จเพื่อประหยัดพื้นที่บน Render
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
}

// Endpoint หลักสำหรับเปรียบเทียบ JD กับ Resumes
app.post('/api/compare', upload.fields([{ name: 'jd', maxCount: 1 }, { name: 'resumes', maxCount: 20 }]), async (req, res) => {
  try {
    if (!req.files['jd'] || !req.files['resumes']) {
      return res.status(400).json({ error: "Missing files" });
    }

    const jdFile = req.files['jd'][0];
    const resumeFiles = req.files['resumes'];
    
    const jdText = await extractTextFromFile(jdFile);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const results = await Promise.all(resumeFiles.map(async (file, index) => {
      const resumeText = await extractTextFromFile(file);
      
      const prompt = `
        You are a Senior HR Tech and AI Expert. Compare the following Job Description (JD) and Resume.
        
        JD Content: ${jdText.substring(0, 3000)}
        Resume Content: ${resumeText.substring(0, 3000)}
        
        Tasks:
        1. Calculate a "Match Score" (0-100)
        2. Provide a concise "Thai Summary" (สรุปจุดเด่นภาษาไทย)
        
        Output format (STRICT JSON ONLY):
        { "score": 85, "summary": "สรุปภาษาไทย..." }
      `;

      try {
        const result = await model.generateContent(prompt);
        const responseText = result.response.text();
        const jsonMatch = responseText.match(/\{.*\}/s);
        const aiData = JSON.parse(jsonMatch[0]);
        
        return {
          id: (Date.now() + index).toString(),
          name: file.originalname.split('.')[0],
          score: aiData.score,
          summary: aiData.summary
        };
      } catch (e) {
        return {
          id: (Date.now() + index).toString(),
          name: file.originalname.split('.')[0],
          score: 0,
          summary: "Error during AI analysis"
        };
      }
    }));

    res.json(results);
  } catch (error) {
    console.error("Comparison Error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Health check สำหรับ Render
app.get('/health', (req, res) => res.send('Server is healthy!'));

app.listen(port, () => console.log(`AI Engine is LIVE on port ${port}`));
