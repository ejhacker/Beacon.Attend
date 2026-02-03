/**
 * geminiService.js
 *
 * Calls Gemini AI to parse a timetable image.
 * Set VITE_GEMINI_API_KEY in your .env file (or Vercel env vars).
 * If no key is set it returns mock data so you can still test everything.
 */

const API_KEY = import.meta.env.VITE_GEMINI_API_KEY || '';
const MODEL  = 'gemini-1.5-flash';
const URL    = 'https://generativelanguage.googleapis.com/v1beta/models/' + MODEL + ':generateContent?key=' + API_KEY;

export async function parseTimetableImage(base64DataURL) {
  // Debug: Check if API key is available
  const envKey = import.meta.env.VITE_GEMINI_API_KEY;
  console.log('Gemini API Key check:', envKey ? 'Present (length: ' + envKey.length + ')' : 'MISSING');
  
  if (!API_KEY) {
    console.warn('No Gemini API key – returning mock timetable.');
    console.warn('Set VITE_GEMINI_API_KEY in your environment variables.');
    await new Promise(r => setTimeout(r, 1800));
    return mockData();
  }

  if (!base64DataURL) {
    throw new Error('No image data provided');
  }

  const base64  = base64DataURL.includes(',') ? base64DataURL.split(',')[1] : base64DataURL;
  const mime    = base64DataURL.includes('png') ? 'image/png' : base64DataURL.includes('jpeg') || base64DataURL.includes('jpg') ? 'image/jpeg' : 'image/jpeg';
  
  // Check image size (Gemini has limits)
  const sizeInBytes = (base64.length * 3) / 4;
  const sizeInMB = sizeInBytes / (1024 * 1024);
  console.log('Image size:', sizeInMB.toFixed(2), 'MB');
  
  if (sizeInMB > 20) {
    throw new Error('Image too large. Please use an image smaller than 20MB.');
  }

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

  try {
    const res = await fetch(URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    
    if (!res.ok) {
      const errorText = await res.text();
      console.error('Gemini API error:', res.status, errorText);
      throw new Error(`Gemini API error ${res.status}: ${errorText.substring(0, 100)}`);
    }

    const json = await res.json();
    
    // Handle API errors in response
    if (json.error) {
      console.error('Gemini API error response:', json.error);
      throw new Error(`Gemini API error: ${json.error.message || JSON.stringify(json.error)}`);
    }

    const raw = (json.candidates && json.candidates[0] && json.candidates[0].content && json.candidates[0].content.parts && json.candidates[0].content.parts[0] && json.candidates[0].content.parts[0].text) || '[]';
    const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    
    try {
      const parsed = JSON.parse(cleaned);
      if (!Array.isArray(parsed)) {
        throw new Error('Parsed result is not an array');
      }
      return parsed;
    } catch (parseError) {
      console.error('Failed to parse Gemini response:', cleaned);
      throw new Error(`Failed to parse timetable data: ${parseError.message}`);
    }
  } catch (error) {
    // Re-throw with more context if it's not already our error
    if (error.message && error.message.includes('Gemini API') || error.message.includes('Failed to parse')) {
      throw error;
    }
    console.error('Network or other error:', error);
    throw new Error(`Failed to process timetable: ${error.message}`);
  }
}

function mockData() {
  return [
    { subject: 'Machine Learning',  timeStart: '09:00', timeEnd: '10:30', room: 'LH-204' },
    { subject: 'Data Structures',   timeStart: '11:00', timeEnd: '12:30', room: 'LH-101' },
    { subject: 'AI Fundamentals',   timeStart: '14:00', timeEnd: '15:30', room: 'LH-204' },
    { subject: 'Database Systems',  timeStart: '16:00', timeEnd: '17:00', room: 'LH-302' }
  ];
}
