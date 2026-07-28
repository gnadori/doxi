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

// Helper to fix common Hungarian speech-to-text phonetic spelling typos & STEM/Humanities distortions
function fixHungarianSpelling(text: string): string {
  if (!text) return '';
  return text
    .replace(/médián évum/gi, 'Medium Aevum')
    .replace(/Erdo Bruni/gi, 'Leonardo Bruni')
    .replace(/Milano-nyevediktum/gi, 'milanói ediktum')
    .replace(/milano-ediktum/gi, 'milanói ediktum')
    .replace(/három történelem/gi, 'hármas korszakolás')
    .replace(/három stakolást/gi, 'hármas korszakolás')
    .replace(/nyugatrom viradalom/gi, 'Nyugatrómai Birodalom')
    .replace(/nyugatrom viradalomát/gi, 'Nyugatrómai Birodalom bukása')
    .replace(/Balcman/gi, 'Boltzmann')
    .replace(/Bolcman/gi, 'Boltzmann')
    .replace(/Avogadro-rozsma/gi, 'Avogadro-szám')
    .replace(/Avogadrorozsma/gi, 'Avogadro-szám')
    .replace(/gázalandó/gi, 'gázállandó')
    .replace(/pécketől[\s,]*véketőpertékető/gi, 'p1·V1/T1 = p2·V2/T2')
    .replace(/pécketől/gi, 'p1·V1')
    .replace(/véketőpertékető/gi, 'V2/T2')
    .replace(/hőmérséglet/gi, 'hőmérséklet')
    .replace(/hőmérségleti/gi, 'hőmérsékleti')
    .replace(/hőmérségletet/gi, 'hőmérsékletet')
    .replace(/hőmérséglettel/gi, 'hőmérséklettel')
    .replace(/hőmérséglete/gi, 'hőmérséklete')
    .replace(/hőmérségletre/gi, 'hőmérsékletre')
    .replace(/hőmérségletből/gi, 'hőmérsékletből')
    .replace(/hőmérséglethez/gi, 'hőmérséklethez')
    .replace(/borosztján/gi, 'borostyán')
    .replace(/reprodukányomagát/gi, 'szaporodását')
    .replace(/szarómaik/gi, 'szarmaták')
    .replace(/mohán/gi, 'tápanyag')
    .replace(/mohány/gi, 'tápanyag');
}

// Helper to strip unwanted labels (e.g. "Helyes válasz:", "Tévesztő A:", "Option A:") from option text
function sanitizeOptionText(text: string): string {
  if (!text) return '';
  const cleaned = text
    .replace(/^(Helyes válasz|Helyes|Tévesztő [A-Z0-9]?|Tévesztő|Option [A-Z0-9]?|[A-D])\s*[:\.-]\s*/gi, '')
    .trim();
  return fixHungarianSpelling(cleaned);
}

// Helper to format raw transcript into structured sentences and paragraphs WITHOUT rewriting words
async function cleanTranscriptWithAI(ai: any, rawTranscript: string, topic?: string): Promise<string> {
  const FORMAT_PROMPT = `You are a Hungarian text editor. Your ONLY task is to structure the speech transcript into clear sentences and logical paragraphs with proper capitalization and punctuation.
${topic ? `\nLECTURE TOPIC: "${topic}"` : ''}

RULES:
1. DO NOT change, rephrase, or substitute the speaker's words. Preserve the exact vocabulary.
2. Format into clean sentences with proper initial capitalization and ending punctuation (periods, question marks, exclamation marks).
3. Group related sentences into clean paragraphs separated by double line breaks (\\n\\n).
4. Output ONLY the formatted Hungarian text without quotes or markdown code blocks.`;

  const models = [
    '@cf/qwen/qwen1.5-14b-chat',
    '@cf/qwen/qwen1.5-7b-chat',
    '@cf/mistral/mistral-7b-instruct-v0.2',
    '@cf/meta/llama-3.2-3b-instruct'
  ];

  for (const model of models) {
    try {
      const res = await ai.run(model, {
        messages: [
          { role: 'system', content: FORMAT_PROMPT },
          { role: 'user', content: rawTranscript }
        ],
        max_tokens: 1024
      });
      const text = typeof res === 'string' ? res : res?.response;
      if (text && text.trim()) {
        return fixHungarianSpelling(text.trim().replace(/^"|"$/g, ''));
      }
    } catch (e) {
      console.error(`Transcript formatting error (${model}):`, e);
    }
  }

  return fixHungarianSpelling(rawTranscript);
}

// Helper to generate universal high-quality multiple choice questions in Hungarian for ANY subject
async function generate5QuestionsWithAI(ai: any, cleanTranscript: string, topic?: string): Promise<any[]> {
  const QUIZ_GEN_PROMPT = `You are a universal academic exam question designer. Analyze the lecture transcript across ANY discipline (History, Literature, Physics, Biology, Law, IT, Economics, Chemistry, Mathematics, Geography, etc.) and generate 3 to 5 distinct multiple-choice questions.
${topic ? `\nLECTURE TOPIC / SUBJECT ANCHOR: "${topic}"\nEnsure questions directly test key concepts related to this lecture topic.` : ''}

STRICT INSTRUCTIONS:
1. Write 3 to 5 high-quality, professional questions IN NATURAL, GRAMMATICALLY PERFECT HUNGARIAN.
2. Each question text MUST be a real question ending with "?". DO NOT copy the transcript verbatim as the question.
3. Provide 4 distinct options per question (1 correct answer matching the facts, 3 realistic distractors). DO NOT include any labels like "Helyes válasz", "Tévesztő", or "A:".
4. Respond ONLY with a valid JSON object matching this exact structure:
{
  "questions": [
    {
      "text": "Mi az elhangzott előadásrészlet tézisének lényege?",
      "options": [
        "A helyes megállapítás",
        "Eltérő elméleti megközelítés",
        "Ellentmondásos feltételezés",
        "Egyik sem a fentiek közül"
      ],
      "correctIndex": 0,
      "explanation": "Rövid szakmai magyarázat a leirat alapján."
    }
  ]
}`;

  const models = [
    '@cf/qwen/qwen1.5-14b-chat',
    '@cf/qwen/qwen1.5-7b-chat',
    '@cf/mistral/mistral-7b-instruct-v0.2',
    '@cf/meta/llama-3.2-3b-instruct'
  ];

  let questions: any[] = [];

  for (const model of models) {
    try {
      const res = await ai.run(model, {
        messages: [
          { role: 'system', content: QUIZ_GEN_PROMPT },
          { role: 'user', content: `Előadás leirata:\n"${cleanTranscript}"` }
        ],
        max_tokens: 2048
      });

      let rawText = '';
      if (typeof res === 'string') {
        rawText = res;
      } else if (res && typeof res.response === 'string') {
        rawText = res.response;
      } else if (res && typeof res.response === 'object') {
        rawText = JSON.stringify(res.response);
      }

      if (rawText.trim()) {
        rawText = rawText.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
        rawText = rawText.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

        try {
          const parsed = JSON.parse(rawText);
          const batch = Array.isArray(parsed.questions) ? parsed.questions : (parsed.text ? [parsed] : []);
          batch.forEach((q: any) => {
            if (q.text && Array.isArray(q.options) && q.options.length === 4) {
              const cleanText = q.text.trim();
              if (!questions.some((ex: any) => ex.text === cleanText)) {
                q.options = q.options.map((opt: string) => sanitizeOptionText(opt));
                questions.push(q);
              }
            }
          });
        } catch (parseErr) {
          const matches = rawText.match(/\{[^{}]*"text"[^{}]*"options"[^{}]*\}/g);
          if (matches) {
            for (const m of matches) {
              try {
                const q = JSON.parse(m);
                if (q.text && q.options && Array.isArray(q.options) && q.options.length === 4) {
                  q.options = q.options.map((opt: string) => sanitizeOptionText(opt));
                  questions.push(q);
                }
              } catch (e) {}
            }
          }
        }
      }

      if (questions.length >= 2) break;
    } catch (e) {
      console.error(`Quiz generation model error (${model}):`, e);
    }
  }

  // Universal Fallback if parsing produced no questions
  if (questions.length === 0 && cleanTranscript.length > 5) {
    const firstSentence = cleanTranscript.split('.')[0] || cleanTranscript;
    questions.push({
      text: `Mire utal az előadásban elhangzott alábbi szakmai megállapítás: "${firstSentence.substring(0, 55)}..."?`,
      options: [
        firstSentence.substring(0, 45),
        "Általános igazgatási közleményekre",
        "Jogszabályi és elméleti keretekre",
        "Egyik sem a fentiek közül"
      ],
      correctIndex: 0,
      explanation: "Közvetlenül az elhangzott előadásrészletből származik."
    });
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
    let topic: string | undefined = undefined;

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
      if (typeof body['topic'] === 'string' && body['topic'].trim()) {
        topic = body['topic'].trim();
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

    if (!rawTranscript || rawTranscript.length < 8) {
      return c.json({
        error: 'Túl rövid vagy nem jól érthető felvétel',
        details: 'A rögzített hanganyag túl rövid volt. Kérlek beszélj 10-15 másodpercig az előadásról a jobb felismeréshez!',
        rawTranscript
      }, 400);
    }

    // Step 1: Format transcript into clean sentences and paragraphs without rewriting words
    const cleanTranscript = await cleanTranscriptWithAI(c.env.AI, rawTranscript, topic);

    // Save active clean transcript to KV for "Generate More" feature
    try {
      await c.env.LECTURE_KV.put(`transcript:${roomId}`, cleanTranscript, { expirationTtl: 86400 });
      if (topic) {
        await c.env.LECTURE_KV.put(`topic:${roomId}`, topic, { expirationTtl: 86400 });
      }
    } catch (e) {}

    // Step 2: Generate high quality Hungarian questions batch from the formatted transcript
    let generatedQuestions = await generate5QuestionsWithAI(c.env.AI, cleanTranscript, topic);

    const savedQuestions = [];
    const now = Date.now();

    for (const q of generatedQuestions) {
      const questionId = `q_${now}_${Math.random().toString(36).substring(2, 7)}`;

      let questionText = (q.text || 'Megértési ellenőrző kérdés').trim();
      if (questionText === cleanTranscript.trim() || questionText === rawTranscript.trim()) {
        questionText = 'Mi a legfőbb megállapítás az elhangzott előadásrészlet alapján?';
      }

      const questionObj = {
        id: questionId,
        text: fixHungarianSpelling(questionText),
        options: Array.isArray(q.options) && q.options.length === 4 ? q.options.map((opt: string) => sanitizeOptionText(opt)) : [
          sanitizeOptionText(q.options?.[0] || 'Elsődleges megállapítás'),
          sanitizeOptionText(q.options?.[1] || 'Alternatív elmélet'),
          sanitizeOptionText(q.options?.[2] || 'Eltérő állítás'),
          sanitizeOptionText(q.options?.[3] || 'Egyik sem')
        ],
        correctIndex: typeof q.correctIndex === 'number' && q.correctIndex >= 0 && q.correctIndex < 4 ? q.correctIndex : 0,
        explanation: fixHungarianSpelling(q.explanation || 'Az elhangzottak alapján.'),
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
      topic,
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
    let topic: string | undefined = undefined;

    const body = await c.req.parseBody().catch(() => ({} as any));
    if (typeof body['transcript'] === 'string') {
      cleanTranscript = body['transcript'];
    }
    if (typeof body['topic'] === 'string' && body['topic'].trim()) {
      topic = body['topic'].trim();
    }

    if (!cleanTranscript) {
      const stored = await c.env.LECTURE_KV.get(`transcript:${roomId}`);
      if (stored) cleanTranscript = stored;
    }
    if (!topic) {
      const storedTopic = await c.env.LECTURE_KV.get(`topic:${roomId}`);
      if (storedTopic) topic = storedTopic;
    }

    if (!cleanTranscript) {
      return c.json({ error: 'Nincs elmentett előadásleirat a szobához' }, 400);
    }

    const generatedQuestions = await generate5QuestionsWithAI(c.env.AI, cleanTranscript, topic);
    const savedQuestions = [];
    const now = Date.now();

    for (const q of generatedQuestions) {
      const questionId = `q_${now}_${Math.random().toString(36).substring(2, 7)}`;
      const questionObj = {
        id: questionId,
        text: fixHungarianSpelling(q.text || 'Megértési ellenőrző kérdés'),
        options: Array.isArray(q.options) && q.options.length === 4 ? q.options.map((opt: string) => sanitizeOptionText(opt)) : [
          sanitizeOptionText(q.options?.[0] || 'Elsődleges megállapítás'),
          sanitizeOptionText(q.options?.[1] || 'Alternatív elmélet'),
          sanitizeOptionText(q.options?.[2] || 'Eltérő állítás'),
          sanitizeOptionText(q.options?.[3] || 'Egyik sem')
        ],
        correctIndex: typeof q.correctIndex === 'number' && q.correctIndex >= 0 && q.correctIndex < 4 ? q.correctIndex : 0,
        explanation: fixHungarianSpelling(q.explanation || 'Az elhangzottak alapján.'),
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
