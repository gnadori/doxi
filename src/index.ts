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

// Smart Fallback Question Generator
function generateFallbackQuestion(transcript: string) {
  const cleanTranscript = transcript.trim();
  const words = cleanTranscript.split(/\s+/);
  const keyConcept = words.slice(0, 8).join(' ');

  const isHu = /[áéíóöőúüű]/i.test(transcript);
  
  if (isHu) {
    return [
      {
        text: `Mire vonatkozik az alábbi előadásrészlet: "${keyConcept}..."?`,
        options: [
          `Előadási főtéma: ${keyConcept}`,
          "Környezetvédelmi szabályozás",
          "Általános igazgatási közlemények",
          "Történelmi események időrendje"
        ],
        correctIndex: 0,
        explanation: `Az előadás közvetlenül a megadott témát tárgyalja.`
      }
    ];
  }

  return [
    {
      text: `Which core topic is discussed in the snippet: "${keyConcept}..."?`,
      options: [
        keyConcept,
        "General administrative announcements",
        "Historical timelines",
        "Unrelated scientific theory"
      ],
      correctIndex: 0,
      explanation: `Extracted directly from the lecture segment.`
    }
  ];
}

// 1. Audio Ingestion & Quiz Generation Endpoint
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

    let transcript = '';

    if (textSample) {
      transcript = textSample;
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
          transcript = whisperRes?.text || whisperRes?.transcript || '';
          if (transcript) break;
        } catch (err: any) {
          console.error(`Whisper error with model ${model}:`, err);
          whisperErr = err.message || String(err);
        }
      }

      if (!transcript && whisperErr) {
        return c.json({ error: 'Failed to transcribe audio with Whisper AI', details: whisperErr }, 500);
      }
    } else {
      return c.json({ error: 'No audio or text content provided' }, 400);
    }

    if (!transcript.trim()) {
      return c.json({ error: 'Empty transcript received' }, 400);
    }

    const SYSTEM_PROMPT = `You are a high-level educational AI. Generate 1 multiple-choice test question based on the lecture transcript.

RULES:
1. Write a clear, concise question asking about a key fact in the transcript. DO NOT copy the transcript verbatim as the question.
2. Provide 4 distinct options (1 correct answer matching the transcript, 3 realistic wrong choices).
3. Output ONLY a raw JSON object (NO markdown blocks, NO preamble):
{
  "questions": [
    {
      "text": "Milyen anyag keletkezik a fotoszintézis során?",
      "options": ["Glükóz és oxigén", "Szén-monoxid", "Sók és ásványi anyagok", "Nitrogéngáz"],
      "correctIndex": 0,
      "explanation": "A fotoszintézis során a növények glükózt és oxigént állítanak elő."
    }
  ]
}`;

    const modelsToTry = [
      '@cf/meta/llama-3.2-3b-instruct',
      '@cf/meta/llama-3.2-1b-instruct',
      '@cf/mistral/mistral-7b-instruct-v0.2',
      '@cf/qwen/qwen1.5-7b-chat'
    ];

    let llmRes: any = null;
    let modelUsed = '';
    let errorLogs: string[] = [];

    for (const model of modelsToTry) {
      try {
        llmRes = await c.env.AI.run(model, {
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: `Transcript:\n"${transcript}"` },
          ],
        });
        if (llmRes && (llmRes.response || typeof llmRes === 'string')) {
          modelUsed = model;
          break;
        }
      } catch (err: any) {
        console.error(`LLM error (${model}):`, err);
        errorLogs.push(`${model}: ${err.message || String(err)}`);
      }
    }

    let generatedQuestions: any[] = [];
    let rawText = '';

    if (llmRes) {
      if (typeof llmRes === 'string') {
        rawText = llmRes;
      } else if (llmRes && typeof llmRes.response === 'string') {
        rawText = llmRes.response;
      } else if (llmRes && typeof llmRes.response === 'object') {
        rawText = JSON.stringify(llmRes.response);
      } else {
        rawText = JSON.stringify(llmRes);
      }

      // Strip markdown code fences if present
      rawText = rawText.replace(/```json\s*/gi, '').replace(/```/g, '').trim();

      try {
        const parsed = JSON.parse(rawText);
        if (Array.isArray(parsed.questions)) {
          generatedQuestions = parsed.questions;
        } else if (parsed.text && parsed.options) {
          generatedQuestions = [parsed];
        }
      } catch (parseErr) {
        const match = rawText.match(/\{[\s\S]*\}/);
        if (match) {
          try {
            const parsed = JSON.parse(match[0]);
            generatedQuestions = parsed.questions || [parsed];
          } catch (e) {}
        }
      }
    }

    if (!generatedQuestions || generatedQuestions.length === 0) {
      generatedQuestions = generateFallbackQuestion(transcript);
    }

    const savedQuestions = [];
    const now = Date.now();

    for (const q of generatedQuestions) {
      const questionId = `q_${now}_${Math.random().toString(36).substring(2, 7)}`;
      
      // Ensure question text isn't verbatim transcript if verbatim
      let qText = q.text || 'Megértési ellenőrző kérdés';
      if (qText.trim() === transcript.trim()) {
        const firstWords = transcript.trim().split(/\s+/).slice(0, 6).join(' ');
        qText = `Mit állít az előadó a következőről: "${firstWords}..."?`;
      }

      const questionObj = {
        id: questionId,
        text: qText,
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
      transcript,
      questions: savedQuestions,
      debug: {
        modelUsed,
        rawText: rawText.substring(0, 200),
        errorLogs
      }
    });

  } catch (globalErr: any) {
    console.error('Global Route Handler Error:', globalErr);
    return c.json({ error: 'Endpoint processing error', details: globalErr.message || String(globalErr) }, 500);
  }
});

// 2. WebSocket Real-time Endpoint
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

// 3. Fallback / Static Assets Route
app.get('*', async (c) => {
  if (c.env.ASSETS) {
    return c.env.ASSETS.fetch(c.req.raw);
  }
  return c.text('LiveLectureQuiz Workers Server Running');
});

export default app;
