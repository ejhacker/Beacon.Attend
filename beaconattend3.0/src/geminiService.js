/**
 * geminiService.js
 *
 * Calls Gemini AI to parse a timetable image.
 * Set VITE_GEMINI_API_KEY in your .env file (or Vercel env vars).
 * If no key is set it returns mock data so you can still test everything.
 */

const API_KEY = process.env.GEMINI_API_KEY || '';
const MODEL  = 'gemini-1.5-flash';
const URL    = 'https://generativelanguage.googleapis.com/v1beta/models/' + MODEL + ':generateContent?key=' + API_KEY;

export async function parseTimetableImage(base64DataURL) {
  if (!API_KEY) {
    console.warn('No Gemini API key – returning mock timetable.');
    await new Promise(r => setTimeout(r, 1800));
    return mockData();
  }

  const base64  = base64DataURL.includes(',') ? base64DataURL.split(',')[1] : base64DataURL;
  const mime    = base64DataURL.includes('png') ? 'image/png' : 'image/jpeg';

  const body = {
    contents: [{
      parts: [
        { inlineData: { mimeType: mime, data: base64 } },
        {
          text: 'You are a timetable parser. Extract ALL class sessions from this timetable image.\nReturn ONLY valid JSON – an array of objects, no markdown, no extra text.\nEach object: { "subject": string, "timeStart": "HH:MM", "timeEnd": "HH:MM", "room": string }\nExample: [{"subject":"Machine Learning","timeStart":"09:00","timeEnd":"10:30","room":"LH-204"}]'
        }
      ]
    }]
  };

  const res = await fetch(URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error('Gemini API error ' + res.status);

  const json    = await res.json();
  const raw     = (json.candidates && json.candidates[0] && json.candidates[0].content && json.candidates[0].content.parts && json.candidates[0].content.parts[0] && json.candidates[0].content.parts[0].text) || '[]';
  const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  return JSON.parse(cleaned);
}

function mockData() {
  return [
    { subject: 'Machine Learning',  timeStart: '09:00', timeEnd: '10:30', room: 'LH-204' },
    { subject: 'Data Structures',   timeStart: '11:00', timeEnd: '12:30', room: 'LH-101' },
    { subject: 'AI Fundamentals',   timeStart: '14:00', timeEnd: '15:30', room: 'LH-204' },
    { subject: 'Database Systems',  timeStart: '16:00', timeEnd: '17:00', room: 'LH-302' }
  ];
}
