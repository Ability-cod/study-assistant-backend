require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const multer = require('multer');
const { PDFParse } = require('pdf-parse');
const mammoth = require('mammoth');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-3.1-flash-lite' });

const db = mysql.createPool({
  host: 'localhost',
  user: 'root',
  password: '',
  database: 'study_assistant'
});

async function generateWithRetry(prompt, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await model.generateContent(prompt);
    } catch (err) {
      if (err.status === 503 && i < retries - 1) {
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      throw err;
    }
  }
}

app.post('/generate-questions', async (req, res) => {
  try {
    const { notes } = req.body;

    if (!notes) {
      return res.status(400).json({ error: 'Notes text is required' });
    }

    const wordCount = notes.trim().split(/\s+/).length;
    const numQuestions = Math.min(20, Math.max(3, Math.round(wordCount / 40)));

    const prompt = `Based on the following notes, generate ${numQuestions} quiz questions with their correct answers, covering the material thoroughly without repeating the same idea.
Return ONLY valid JSON, no extra text, in this exact format:
[{"question": "...", "answer": "..."}]

Notes:
${notes}`;

    const result = await generateWithRetry(prompt);
    const text = result.response.text();
    const cleaned = text.replace(/```json|```/g, '').trim();
    const questions = JSON.parse(cleaned);

    const [noteResult] = await db.query(
      'INSERT INTO notes (content) VALUES (?)',
      [notes]
    );
    const noteId = noteResult.insertId;

    const questionIds = [];
    for (const q of questions) {
      const [qResult] = await db.query(
        'INSERT INTO questions (note_id, question, correct_answer) VALUES (?, ?, ?)',
        [noteId, q.question, q.answer]
      );
      questionIds.push(qResult.insertId);
    }

    const questionsForClient = questions.map(q => ({ question: q.question }));

    res.json({ noteId, questions: questionsForClient, questionIds });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong', details: err.message });
  }
});

app.post('/grade-answer', async (req, res) => {
  try {
    const { questionId, studentAnswer } = req.body;

    if (!questionId || !studentAnswer) {
      return res.status(400).json({ error: 'questionId and studentAnswer are required' });
    }

    const [rows] = await db.query(
      'SELECT question, correct_answer FROM questions WHERE id = ?',
      [questionId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Question not found' });
    }

    const { question, correct_answer } = rows[0];

    const prompt = `Question: ${question}
Correct answer: ${correct_answer}
Student's answer: ${studentAnswer}

Is the student's answer correct (allow for close/equivalent wording)? Reply ONLY with valid JSON, no extra text:
{"correct": true or false}`;

    const result = await generateWithRetry(prompt);
    const text = result.response.text();
    const cleaned = text.replace(/```json|```/g, '').trim();
    const grading = JSON.parse(cleaned);

    res.json({ correct: grading.correct, correctAnswer: correct_answer });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong', details: err.message });
  }
});

app.post('/extract-text', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const { mimetype, buffer } = req.file;
    let extractedText = '';

    if (mimetype === 'application/pdf') {
      const parser = new PDFParse({ data: buffer });
      const data = await parser.getText();
      await parser.destroy();
      extractedText = data.text;

    } else if (mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      const result = await mammoth.extractRawText({ buffer });
      extractedText = result.value;

    } else if (mimetype.startsWith('image/')) {
      const imagePart = {
        inlineData: {
          data: buffer.toString('base64'),
          mimeType: mimetype
        }
      };
      const result = await generateWithRetry([
        'Extract all readable text from this image. Return ONLY the extracted text, nothing else.',
        imagePart
      ]);
      extractedText = result.response.text();

    } else {
      return res.status(400).json({ error: 'Unsupported file type. Use PDF, DOCX, or an image.' });
    }

    extractedText = extractedText.trim();

    if (!extractedText) {
      return res.status(400).json({ error: 'Could not extract any text from this file.' });
    }

    res.json({ text: extractedText });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to process file', details: err.message });
  }
});

const PORT = 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));