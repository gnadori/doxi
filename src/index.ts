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

// Health check
app.get('/api/health', (c) => c.json({ status: 'ok', timestamp: Date.now() }));

// Helper to generate a smart fallback question from transcript text if LLM models fail
function generateFallbackQuestion(transcript: string) {
  const snippet = transcript.trim().substring(0, 60);
  const isHu = /[áéíóöőúüű]/i.test(transcript);
  
  if (isHu) {
    return [
      {
        text: `Ellenőrző kérdés: Az elhangzott előadásrészlet alapján ("${snippet}..."), melyik állítás helyes?`,
        options: [
          `Az előadás a következőt tárgyalja: ${snippet}`,
          `A témának nincs köze a megadott tényhez`,
          `Nem hangzott el érdemi információ a szakaszban`,
          `Egyik sem a fentiek közül`
        ],
        correctIndex: 0,
        explanation: `Közvetlenül az elhangzott előadásrészletből származik.`
      }
    ];
  }

  return [
    {
      text: `Comprehension Check: Based on the lecture segment ("${snippet}..."), which statement is correct?`,
      options: [
        `The lecture discusses: ${snippet}`,
        `The topic is unrelated to ${snippet}`,
        `No scientific principles were mentioned in this section`,
        `None of the above`
      ],
      correctIndex: 0,
      explanation: `Derived directly from the recorded lecture segment.`
    }
  ];
}

// 1. Audio Ingestion & Quiz Generation Endpoint
app.post('/api/room/:roomId/audio', async (c) => {
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
    } else if (typeof file === 'string') {
      if (file.startsWith('data:')) {
        const base64Data = file.split(',')[1] || '';
        const binaryStr = atob(base64Data);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) {
          bytes[i] = binaryStr.charCodeAt(i);
        }
        audioBuffer = bytes.buffer;
      }
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

  const SYSTEM_PROMPT = `You are an expert pedagogical assistant. Analyze the provided transcript chunk from a lecture and generate 1 or 2 multiple-choice comprehension check questions.

CRITICAL INSTRUCTIONS:
- You MUST generate questions, options, and explanations IN THE EXACT SAME LANGUAGE AS THE TRANSCRIPT (e.g., if the transcript is in Hungarian, the text, all 4 options, and explanation MUST BE FULLY IN HUNGARIAN).
- You MUST generate 4 distinct, plausible answer choices derived directly from the lecture transcript for each question (1 correct answer and 3 realistic distractors).
- NEVER use generic placeholder strings like "Option A", "Option B", "Option C", "Option D". Always write real, informative answer choices!
- Respond ONLY with a valid JSON object matching this exact structure:
{
  "questions": [
    {
      "text": "Mi a mitokondrium elsődleges feladata a sejtekben?",
      "options": [
        "A DNS szintetizálása",
        "ATP energia termelése sejtlégzéssel",
        "Kalciumionok tárolása",
        "Fehérjék szállítása a Golgi-készülékhez"
      ],
      "correctIndex": 1,
      "explanation": "A mitokondriumok állítják elő az ATP-t, ami a sejtek energiapénze."
    }
  ]
}`;

  const modelsToTry = [
    '@cf/meta/llama-3.3-70b-instruct',
    '@cf/meta/llama-3-8b-instruct',
    '@cf/mistral/mistral-7b-instruct-v0.1',
    '@cf/qwen/qwen1.5-7b-chat'
  ];

  let llmRes: any = null;

  for (const model of modelsToTry) {
    try {
      llmRes = await c.env.AI.run(model, {
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `Lecture transcript:\n"${transcript}"` },
        ],
      });
      if (llmRes && (llmRes.response || typeof llmRes === 'string')) {
        break;
      }
    } catch (err: any) {
      console.error(`Workers AI error with model ${model}:`, err);
    }
  }

  let generatedQuestions: any[] = [];

  if (llmRes) {
    let rawText = typeof llmRes === 'string' ? llmRes : llmRes.response || JSON.stringify(llmRes);
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

  // Fallback to safe question generator if AI LLM fails or is unavailable
  if (!generatedQuestions || generatedQuestions.length === 0) {
    generatedQuestions = generateFallbackQuestion(transcript);
  }

  const savedQuestions = [];
  const now = Date.now();

  for (const q of generatedQuestions) {
    const questionId = `q_${now}_${Math.random().toString(36).substring(2, 7)}`;
    const questionObj = {
      id: questionId,
      text: q.text || 'Sample comprehension check?',
      options: Array.isArray(q.options) && q.options.length === 4 && !q.options.some((o: string) => /^option [a-d]$/i.test(o.trim()))
        ? q.options 
        : [
            q.options?.[0] || 'First key statement from lecture',
            q.options?.[1] || 'Alternative hypothesis',
            q.options?.[2] || 'Contrary scientific opinion',
            q.options?.[3] || 'None of the above'
          ],
      correctIndex: typeof q.correctIndex === 'number' && q.correctIndex >= 0 && q.correctIndex < 4 ? q.correctIndex : 0,
      explanation: q.explanation || 'Based on lecture content.',
      approved: false,
      timestamp: now,
    };

    // Save to Workers KV (24-hour TTL = 86400s)
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

    // Broadcast NEW_QUESTION_PENDING to Teacher WebSocket
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
  });
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
