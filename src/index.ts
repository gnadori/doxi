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
    if (file && file instanceof File) {
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
    try {
      const audioArray = Array.from(new Uint8Array(audioBuffer));
      const whisperRes = await c.env.AI.run(
        '@cf/openai/whisper-large-v3-turbo',
        {
          audio: audioArray,
        }
      );
      transcript = whisperRes?.text || whisperRes?.transcript || '';
    } catch (err: any) {
      console.error('Whisper AI error:', err);
      return c.json({ error: 'Failed to transcribe audio', details: err.message }, 500);
    }
  } else {
    return c.json({ error: 'No audio or text content provided' }, 400);
  }

  if (!transcript.trim()) {
    return c.json({ error: 'Empty transcript received' }, 400);
  }

  // 2. Generate multiple-choice question using Llama 3.1
  const SYSTEM_PROMPT = `You are an expert pedagogical assistant. Analyze the provided transcript chunk from a lecture.
CRITICAL: You MUST respond ONLY with a valid JSON object matching this structure:
{
  "questions": [
    {
      "text": "Question string",
      "options": ["Option A", "Option B", "Option C", "Option D"],
      "correctIndex": 0,
      "explanation": "Brief explanation"
    }
  ]
}`;

  let generatedQuestions: any[] = [];

  try {
    const llmRes = await c.env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Lecture transcript:\n"${transcript}"` },
      ],
      response_format: { type: 'json_object' },
    });

    let rawText = typeof llmRes === 'string' ? llmRes : llmRes.response || JSON.stringify(llmRes);
    // Parse JSON
    try {
      const parsed = JSON.parse(rawText);
      if (Array.isArray(parsed.questions)) {
        generatedQuestions = parsed.questions;
      } else if (parsed.text && parsed.options) {
        generatedQuestions = [parsed];
      }
    } catch (parseErr) {
      // Fallback extract JSON string match
      const match = rawText.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        generatedQuestions = parsed.questions || [parsed];
      }
    }
  } catch (err: any) {
    console.error('LLM generation error:', err);
    return c.json({ error: 'Failed to generate quiz questions', details: err.message }, 500);
  }

  if (!generatedQuestions || generatedQuestions.length === 0) {
    return c.json({ error: 'No valid questions generated' }, 500);
  }

  const savedQuestions = [];
  const now = Date.now();

  for (const q of generatedQuestions) {
    const questionId = `q_${now}_${Math.random().toString(36).substring(2, 7)}`;
    const questionObj = {
      id: questionId,
      text: q.text || 'Sample comprehension check?',
      options: q.options || ['Option A', 'Option B', 'Option C', 'Option D'],
      correctIndex: typeof q.correctIndex === 'number' ? q.correctIndex : 0,
      explanation: q.explanation || 'Based on lecture content.',
      approved: false,
      timestamp: now,
    };

    // Save to Workers KV (24-hour TTL = 86400s)
    await c.env.LECTURE_KV.put(
      `questions:${roomId}:${questionId}`,
      JSON.stringify(questionObj),
      { expirationTtl: 86400 }
    );

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

        // Fetch question from KV
        const rawQuestion = await c.env.LECTURE_KV.get(`questions:${roomId}:${questionId}`);
        if (rawQuestion) {
          const questionObj = JSON.parse(rawQuestion);
          questionObj.approved = true;

          // Update KV
          await c.env.LECTURE_KV.put(
            `questions:${roomId}:${questionId}`,
            JSON.stringify(questionObj),
            { expirationTtl: 86400 }
          );

          // Update Session metadata
          const sessionData = {
            roomId,
            createdAt: Date.now(),
            currentQuestionId: questionId,
            status: 'active',
          };
          await c.env.LECTURE_KV.put(`session:${roomId}`, JSON.stringify(sessionData), {
            expirationTtl: 86400,
          });

          // Broadcast APPROVE_QUESTION / QUESTION_ACTIVE to all students & teacher
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
        const rawResponses = await c.env.LECTURE_KV.get(kvKey);
        let responseData: { responses: Array<{ studentId: string; chosenIndex: number; timestamp: number }> } = {
          responses: [],
        };

        if (rawResponses) {
          try {
            responseData = JSON.parse(rawResponses);
          } catch {}
        }

        // Avoid duplicate response from same studentId if present
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

        await c.env.LECTURE_KV.put(kvKey, JSON.stringify(responseData), { expirationTtl: 86400 });

        // Calculate distribution
        const counts = [0, 0, 0, 0];
        responseData.responses.forEach((r) => {
          if (r.chosenIndex >= 0 && r.chosenIndex < 4) {
            counts[r.chosenIndex]++;
          }
        });

        // Broadcast submission stats to Teacher
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
        // Broadcast CLOSE_QUESTION to all Students
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
