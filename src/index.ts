import { Hono } from 'hono';

export interface Env {
  AI: any;
  LECTURE_KV: KVNamespace;
  ASSETS?: Fetcher;
}

interface SocketClient {
  socket: WebSocket;
  role: 'teacher' | 'student';
  roomId: string;
}

// In-memory WebSocket connections per room (Worker instance scope)
const roomSockets = new Map<string, Set<SocketClient>>();

function getRoomSockets(roomId: string): Set<SocketClient> {
  if (!roomSockets.has(roomId)) {
    roomSockets.set(roomId, new Set());
  }
  return roomSockets.get(roomId)!;
}

function broadcastToRoom(
  roomId: string,
  data: any,
  targetRole?: 'teacher' | 'student'
) {
  const sockets = getRoomSockets(roomId);
  const message = JSON.stringify(data);

  for (const client of sockets) {
    if (!targetRole || client.role === targetRole) {
      try {
        client.socket.send(message);
      } catch (err) {
        console.error('Error sending WS message:', err);
      }
    }
  }
}

const app = new Hono<{ Bindings: Env }>();

// Global Error Handler
app.onError((err, c) => {
  console.error('Hono Error Handler caught:', err);
  return c.json({ error: 'Server Error', details: err.message || String(err) }, 500);
});

// Health check
app.get('/api/health', (c) => c.json({ status: 'ok', timestamp: Date.now() }));

// Helper to clean speech-to-text transcript (Phonetic & Typos correction)
async function cleanTranscriptWithAI(ai: any, rawTranscript: string): Promise<string> {
  const CLEANUP_PROMPT = `You are an expert Hungarian linguist and proofreader. Correct speech-to-text recognition typos, phonetically misheard words, and spelling mistakes in lecture transcripts.

RULES:
1. Fix misheard words (e.g. "borosztján" -> "borostyán", "fastes" -> "fasces", "szarómaik" -> "szarmaták", "összecsosak" -> "összecsapások").
2. Restore proper Hungarian grammar, punctuation, and scientific/historical terminology.
3. Keep the factual meaning intact.
4. Output ONLY the clean corrected Hungarian transcript text without preamble or markdown.`;

  const models = [
    '@cf/meta/llama-3.2-3b-instruct',
    '@cf/meta/llama-3.2-1b-instruct',
    '@cf/mistral/mistral-7b-instruct-v0.2'
  ];

  for (const model of models) {
    try {
      const res = await ai.run(model, {
        messages: [
          { role: 'system', content: CLEANUP_PROMPT },
          { role: 'user', content: rawTranscript }
        ]
      });
      const text = typeof res === 'string' ? res : res?.response;
      if (text && text.trim()) {
        return text.trim().replace(/^"|"$/g, '');
      }
    } catch (e) {
      console.error('Transcript cleanup error:', e);
    }
  }

  return rawTranscript; // Fallback to raw if LLM cleaning fails
}

// Helper to generate a batch of 5 questions
async function generate5QuestionsWithAI(ai: any, cleanTranscript: string): Promise<any[]> {
  const QUIZ_GEN_PROMPT = `You are a master educational assessment designer. Analyze the lecture transcript and generate exactly 5 distinct, high-quality multiple-choice comprehension questions in Hungarian.

REQUIREMENTS:
1. Generate exactly 5 distinct questions covering different factual points or concepts from the transcript.
2. Output 100% in Hungarian (question, all 4 options, and explanation).
3. Each question must have 4 distinct, informative options (1 correct answer, 3 realistic distractors).
4. Output ONLY a valid JSON object matching this structure (no markdown fences, no preamble):
{
  "questions": [
    {
      "text": "Első kérdés szövege?",
      "options": ["Helyes válasz", "Tévesztő A", "Tévesztő B", "Tévesztő C"],
      "correctIndex": 0,
      "explanation": "Rövid magyarázat."
    },
    ... (total 5 questions)
  ]
}`;

  const models = [
    '@cf/meta/llama-3.2-3b-instruct',
    '@cf/meta/llama-3.2-1b-instruct',
    '@cf/mistral/mistral-7b-instruct-v0.2'
  ];

  let rawText = '';

  for (const model of models) {
    try {
      const res = await ai.run(model, {
        messages: [
          { role: 'system', content: QUIZ_GEN_PROMPT },
          { role: 'user', content: `Transcript:\n"${cleanTranscript}"` }
        ]
      });

      if (typeof res === 'string') {
        rawText = res;
      } else if (res && typeof res.response === 'string') {
        rawText = res.response;
      } else if (res && typeof res.response === 'object') {
        rawText = JSON.stringify(res.response);
      }

      if (rawText.trim()) break;
    } catch (e) {
      console.error('Quiz generation model error:', e);
    }
  }

  rawText = rawText.replace(/```json\s*/gi, '').replace(/```/g, '').trim();

  let questions: any[] = [];
  try {
    const parsed = JSON.parse(rawText);
    if (Array.isArray(parsed.questions)) {
      questions = parsed.questions;
    } else if (parsed.text && parsed.options) {
      questions = [parsed];
    }
  } catch (parseErr) {
    const match = rawText.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        questions = parsed.questions || [parsed];
      } catch (e) {}
    }
  }

  return questions;
}

// 1. Audio Ingestion, Transcript Cleaning & Batch Quiz Generation Endpoint
app.post('/api/room/:roomId/audio', async (c) => {
  try {
    const roomId = c.req.param('roomId');
    if (!roomId) {
      return c.json({ error: 'Room ID is required' }, 400);
    }

    let audioBuffer: ArrayBuffer | null = null;
    let textSample: string | null = null;

    const contentType = c.req.header('content-type') || '';
    if (contentType.includes('multipart/form-data')) {
      const body = await c.req.parseBody();
      const file = body['audio'];
      if (file && typeof (file as any).arrayBuffer === 'function') {
        audioBuffer = await (file as any).arrayBuffer();
      } else if (file && file instanceof Blob) {
        audioBuffer = await file.arrayBuffer();
      }
      if (typeof body['text'] === 'string') {
        textSample = body['text'];
      }
    } else {
      audioBuffer = await c.req.arrayBuffer();
    }

    let rawTranscript = '';

    if (textSample) {
      rawTranscript = textSample;
    } else if (audioBuffer && audioBuffer.byteLength > 0) {
      const uint8Array = new Uint8Array(audioBuffer);
      const numberArray = Array.from(uint8Array);

      const whisperModels = [
        '@cf/openai/whisper-large-v3-turbo',
        '@cf/openai/whisper'
      ];

      let whisperErr = '';
      for (const model of whisperModels) {
        try {
          const whisperRes = await c.env.AI.run(model, {
            audio: numberArray,
          });
          rawTranscript = whisperRes?.text || whisperRes?.transcript || '';
          if (rawTranscript) break;
        } catch (err: any) {
          console.error(`Whisper error (${model}):`, err);
          whisperErr = err.message || String(err);
        }
      }

      if (!rawTranscript && whisperErr) {
        return c.json({ error: 'Beszédleiratozási hiba a Whisper AI-nál', details: whisperErr }, 500);
      }
    } else {
      return c.json({ error: 'Nem érkezett hanganyag vagy szöveg' }, 400);
    }

    rawTranscript = rawTranscript.trim();

    if (!rawTranscript || rawTranscript.length < 10) {
      return c.json({
        error: 'Túl rövid vagy nem jól érthető felvétel',
        details: 'A rögzített hanganyag túl rövid volt. Kérlek beszélj 10-15 másodpercig az előadásról a jobb felismeréshez!',
        rawTranscript
      }, 400);
    }

    // Step 1: Clean and phonetically correct the transcript using LLM
    const cleanTranscript = await cleanTranscriptWithAI(c.env.AI, rawTranscript);

    // Save active clean transcript to KV for "Generate 5 More" feature
    try {
      await c.env.LECTURE_KV.put(`transcript:${roomId}`, cleanTranscript, { expirationTtl: 86400 });
    } catch (e) {}

    // Step 2: Generate 5 questions from the cleaned transcript
    let generatedQuestions = await generate5QuestionsWithAI(c.env.AI, cleanTranscript);

    if (!generatedQuestions || generatedQuestions.length === 0) {
      return c.json({
        error: 'Nem sikerült kérdéseket generálni',
        details: 'Próbáld meg kicsit hosszabban vagy tisztábban elmondani a tézist!',
        rawTranscript,
        cleanTranscript
      }, 500);
    }

    const savedQuestions = [];
    const now = Date.now();

    for (const q of generatedQuestions) {
      const questionId = `q_${now}_${Math.random().toString(36).substring(2, 7)}`;

      const questionObj = {
        id: questionId,
        text: q.text || 'Megértési ellenőrző kérdés',
        options: Array.isArray(q.options) && q.options.length === 4 ? q.options : [
          q.options?.[0] || 'Elsődleges megállapítás',
          q.options?.[1] || 'Alternatív elmélet',
          q.options?.[2] || 'Eltérő állítás',
          q.options?.[3] || 'Egyik sem'
        ],
        correctIndex: typeof q.correctIndex === 'number' && q.correctIndex >= 0 && q.correctIndex < 4 ? q.correctIndex : 0,
        explanation: q.explanation || 'Az elhangzottak alapján.',
        approved: false,
        timestamp: now,
      };

      try {
        await c.env.LECTURE_KV.put(
          `questions:${roomId}:${questionId}`,
          JSON.stringify(questionObj),
          { expirationTtl: 86400 }
        );
      } catch (kvErr) {
        console.error('KV Save Error:', kvErr);
      }

      savedQuestions.push(questionObj);

      broadcastToRoom(
        roomId,
        {
          event: 'NEW_QUESTION_PENDING',
          questionObject: questionObj,
        },
        'teacher'
      );
    }

    return c.json({
      success: true,
      roomId,
      rawTranscript,
      cleanTranscript,
      questions: savedQuestions
    });

  } catch (globalErr: any) {
    console.error('Global Route Handler Error:', globalErr);
    return c.json({ error: 'Endpoint processing error', details: globalErr.message || String(globalErr) }, 500);
  }
});

// 2. Generate 5 More Questions Endpoint
app.post('/api/room/:roomId/more-questions', async (c) => {
  try {
    const roomId = c.req.param('roomId');
    let cleanTranscript = '';

    const body = await c.req.parseBody().catch(() => ({} as any));
    if (typeof body['transcript'] === 'string') {
      cleanTranscript = body['transcript'];
    }

    if (!cleanTranscript) {
      const stored = await c.env.LECTURE_KV.get(`transcript:${roomId}`);
      if (stored) cleanTranscript = stored;
    }

    if (!cleanTranscript) {
      return c.json({ error: 'Nincs elmentett előadásleirat a szobához' }, 400);
    }

    const generatedQuestions = await generate5QuestionsWithAI(c.env.AI, cleanTranscript);
    const savedQuestions = [];
    const now = Date.now();

    for (const q of generatedQuestions) {
      const questionId = `q_${now}_${Math.random().toString(36).substring(2, 7)}`;
      const questionObj = {
        id: questionId,
        text: q.text || 'Megértési ellenőrző kérdés',
        options: Array.isArray(q.options) && q.options.length === 4 ? q.options : [
          q.options?.[0] || 'Elsődleges megállapítás',
          q.options?.[1] || 'Alternatív elmélet',
          q.options?.[2] || 'Eltérő állítás',
          q.options?.[3] || 'Egyik sem'
        ],
        correctIndex: typeof q.correctIndex === 'number' && q.correctIndex >= 0 && q.correctIndex < 4 ? q.correctIndex : 0,
        explanation: q.explanation || 'Az elhangzottak alapján.',
        approved: false,
        timestamp: now,
      };

      try {
        await c.env.LECTURE_KV.put(
          `questions:${roomId}:${questionId}`,
          JSON.stringify(questionObj),
          { expirationTtl: 86400 }
        );
      } catch (e) {}

      savedQuestions.push(questionObj);

      broadcastToRoom(
        roomId,
        {
          event: 'NEW_QUESTION_PENDING',
          questionObject: questionObj,
        },
        'teacher'
      );
    }

    return c.json({
      success: true,
      roomId,
      cleanTranscript,
      questions: savedQuestions
    });
  } catch (err: any) {
    return c.json({ error: 'Kérdésgenerálási hiba', details: err.message }, 500);
  }
});

// 3. WebSocket Real-time Endpoint
app.get('/ws/room/:roomId', async (c) => {
  const roomId = c.req.param('roomId');
  const role = (c.req.query('role') === 'teacher' ? 'teacher' : 'student') as 'teacher' | 'student';

  const upgradeHeader = c.req.header('Upgrade');
  if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
    return c.text('Expected Upgrade: websocket', 426);
  }

  const webSocketPair = new WebSocketPair();
  const clientSocket = webSocketPair[0];
  const serverSocket = webSocketPair[1];

  serverSocket.accept();

  const client: SocketClient = {
    socket: serverSocket,
    role,
    roomId,
  };

  const roomSet = getRoomSockets(roomId);
  roomSet.add(client);

  serverSocket.addEventListener('message', async (event) => {
    try {
      const data = JSON.parse(event.data.toString());

      if (data.event === 'APPROVE_QUESTION') {
        const questionId = data.questionId;
        if (!questionId) return;

        let questionObj = data.questionObject;

        if (!questionObj) {
          const rawQuestion = await c.env.LECTURE_KV.get(`questions:${roomId}:${questionId}`);
          if (rawQuestion) {
            questionObj = JSON.parse(rawQuestion);
          }
        }

        if (questionObj) {
          questionObj.approved = true;

          try {
            await c.env.LECTURE_KV.put(
              `questions:${roomId}:${questionId}`,
              JSON.stringify(questionObj),
              { expirationTtl: 86400 }
            );

            const sessionData = {
              roomId,
              createdAt: Date.now(),
              currentQuestionId: questionId,
              status: 'active',
            };
            await c.env.LECTURE_KV.put(`session:${roomId}`, JSON.stringify(sessionData), {
              expirationTtl: 86400,
            });
          } catch (kvErr) {
            console.error('KV update error on approve:', kvErr);
          }

          broadcastToRoom(roomId, {
            event: 'APPROVE_QUESTION',
            questionId,
            questionObject: questionObj,
          });
        }
      } else if (data.event === 'SUBMIT_ANSWER') {
        const { questionId, choiceIndex, studentId } = data;
        if (!questionId || choiceIndex === undefined) return;

        const kvKey = `responses:${roomId}:${questionId}`;
        let responseData: { responses: Array<{ studentId: string; chosenIndex: number; timestamp: number }> } = {
          responses: [],
        };

        try {
          const rawResponses = await c.env.LECTURE_KV.get(kvKey);
          if (rawResponses) {
            responseData = JSON.parse(rawResponses);
          }
        } catch (e) {}

        const existingIdx = responseData.responses.findIndex((r) => r.studentId === studentId);
        if (existingIdx >= 0) {
          responseData.responses[existingIdx] = {
            studentId,
            chosenIndex: choiceIndex,
            timestamp: Date.now(),
          };
        } else {
          responseData.responses.push({
            studentId,
            chosenIndex: choiceIndex,
            timestamp: Date.now(),
          });
        }

        try {
          await c.env.LECTURE_KV.put(kvKey, JSON.stringify(responseData), { expirationTtl: 86400 });
        } catch (e) {}

        const counts = [0, 0, 0, 0];
        responseData.responses.forEach((r) => {
          if (r.chosenIndex >= 0 && r.chosenIndex < 4) {
            counts[r.chosenIndex]++;
          }
        });

        broadcastToRoom(
          roomId,
          {
            event: 'SUBMIT_ANSWER',
            questionId,
            choiceIndex,
            studentId,
            totalSubmissions: responseData.responses.length,
            counts,
            responses: responseData.responses,
          },
          'teacher'
        );
      } else if (data.event === 'CLOSE_QUESTION') {
        const { questionId } = data;
        broadcastToRoom(roomId, {
          event: 'CLOSE_QUESTION',
          questionId,
        });
      }
    } catch (err) {
      console.error('Error handling WebSocket message:', err);
    }
  });

  const cleanup = () => {
    roomSet.delete(client);
  };

  serverSocket.addEventListener('close', cleanup);
  serverSocket.addEventListener('error', cleanup);

  return new Response(null, {
    status: 101,
    webSocket: clientSocket,
  });
});

// 4. Fallback / Static Assets Route
app.get('*', async (c) => {
  if (c.env.ASSETS) {
    return c.env.ASSETS.fetch(c.req.raw);
  }
  return c.text('LiveLectureQuiz Workers Server Running');
});

export default app;
