export interface StudyQuestion {
  id: number;
  difficulty: "Very Easy" | "Easy" | "Medium" | "Hard" | "Very Hard";
  question: string;
  options: [string, string, string, string];
  correctAnswerIndex: number;
  snackReward: number;
}

export interface StudyGuide {
  landmarkSummary: string;
  quiz: [StudyQuestion, StudyQuestion, StudyQuestion, StudyQuestion, StudyQuestion];
}

const wonderNames = [
  "Great Wall of China",
  "Petra",
  "Christ the Redeemer",
  "Machu Picchu",
  "Chichén Itzá",
  "Colosseum",
  "Taj Mahal"
] as const;

const difficulties: StudyQuestion["difficulty"][] = [
  "Very Easy",
  "Easy",
  "Medium",
  "Hard",
  "Very Hard"
];

const rewards = [1, 2, 3, 4, 5];

const studyGuideSchema = {
  type: "OBJECT",
  required: ["landmarkSummary", "quiz"],
  properties: {
    landmarkSummary: { type: "STRING" },
    quiz: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        required: ["id", "difficulty", "question", "options", "correctAnswerIndex", "snackReward"],
        properties: {
          id: { type: "INTEGER" },
          difficulty: { type: "STRING", enum: difficulties },
          question: { type: "STRING" },
          options: {
            type: "ARRAY",
            items: { type: "STRING" }
          },
          correctAnswerIndex: { type: "INTEGER" },
          snackReward: { type: "INTEGER" }
        }
      }
    }
  }
} as const;

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

function normalizeWonderName(name: string): string {
  return name.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase();
}

function isStudyGuide(value: unknown): value is StudyGuide {
  if (!value || typeof value !== "object") return false;
  const guide = value as Partial<StudyGuide>;
  if (typeof guide.landmarkSummary !== "string" || !guide.landmarkSummary.trim()) return false;
  if (!Array.isArray(guide.quiz) || guide.quiz.length !== 5) return false;

  return guide.quiz.every((question, index) =>
    Boolean(
      question &&
      question.id === index + 1 &&
      question.difficulty === difficulties[index] &&
      typeof question.question === "string" &&
      question.question.trim() &&
      Array.isArray(question.options) &&
      question.options.length === 4 &&
      new Set(question.options).size === 4 &&
      question.options.every((option) => typeof option === "string" && option.trim()) &&
      Number.isInteger(question.correctAnswerIndex) &&
      question.correctAnswerIndex >= 0 &&
      question.correctAnswerIndex <= 3 &&
      question.snackReward === rewards[index]
    )
  );
}

function extractOutputText(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const response = payload as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> }; finishReason?: unknown }>;
  };
  const text = response.candidates?.[0]?.content?.parts
    ?.filter((part): part is { text: string } => typeof part.text === "string")
    .map((part) => part.text)
    .join("");
  return text || null;
}

function providerErrorMessage(payload: unknown, rawText: string, apiKey: string): string {
  if (payload && typeof payload === "object") {
    const error = (payload as { error?: { message?: unknown } }).error;
    if (typeof error?.message === "string" && error.message.trim()) {
      return error.message.trim().replaceAll(apiKey, "[redacted]").slice(0, 500);
    }
  }
  return rawText.trim().replaceAll(apiKey, "[redacted]").slice(0, 500) || "No error details were returned.";
}

export function createStudyLandmarkHandler(apiKey: string, fetcher: typeof fetch = fetch) {
  return async function handleStudyLandmark(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return jsonResponse({ error: "Method not allowed." }, 405);
    }
    if (!apiKey.trim()) {
      return jsonResponse({ error: "Study guide service is not configured." }, 503);
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: "Request body must be valid JSON." }, 400);
    }
    const requestedName = body && typeof body === "object"
      ? (body as { landmark?: unknown }).landmark
      : null;
    if (typeof requestedName !== "string" || requestedName.length > 60) {
      return jsonResponse({ error: "Choose one of the New 7 Wonders." }, 400);
    }
    const landmark = wonderNames.find((name) => normalizeWonderName(name) === normalizeWonderName(requestedName.trim()));
    if (!landmark) {
      return jsonResponse({ error: "Choose one of the New 7 Wonders." }, 400);
    }

    const prompt = [
      `Create a concise, engaging, factually grounded study guide for ${landmark}.`,
      "First write a self-contained summary of about 100 to 140 words.",
      "Then write exactly five multiple-choice questions using ONLY facts explicitly stated in that summary.",
      "Do not test outside knowledge or introduce facts absent from the summary.",
      "Each question must have exactly four distinct options and exactly one correct answer.",
      "Question IDs must be 1 through 5 in order.",
      "Use these difficulty and reward pairs in order: 1 Very Easy/1 snack, 2 Easy/2 snacks, 3 Medium/3 snacks, 4 Hard/4 snacks, 5 Very Hard/5 snacks.",
      "The summary must be suitable for a family-friendly gamified travel app.",
      "Return only JSON matching the supplied response schema."
    ].join(" ");

    let upstream: Response;
    try {
      upstream = await fetcher("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent", {
        method: "POST",
        headers: {
          "x-goog-api-key": apiKey,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: studyGuideSchema,
            temperature: 0.7,
            maxOutputTokens: 1800
          },
        })
      });
    } catch (error) {
      console.error("Gemini study-guide request failed.", error);
      return jsonResponse({ error: "Could not reach the study guide service. Please try again." }, 502);
    }

    let providerPayload: unknown;
    let providerText = "";
    try {
      providerText = await upstream.text();
      providerPayload = JSON.parse(providerText);
    } catch (error) {
      console.error("Gemini returned a non-JSON response.", upstream.status, error);
      const details = providerText?.trim().replaceAll(apiKey, "[redacted]").slice(0, 500);
      if (!upstream.ok) {
        return jsonResponse({
          error: `Gemini returned HTTP ${upstream.status}: ${details || "No response details."}`,
          providerStatus: upstream.status
        }, 502);
      }
      return jsonResponse({ error: "Gemini returned an unreadable response." }, 502);
    }
    if (!upstream.ok) {
      const details = providerErrorMessage(providerPayload, providerText, apiKey);
      console.error("Gemini rejected the study-guide request.", upstream.status, details);
      return jsonResponse({
        error: `Gemini returned HTTP ${upstream.status}: ${details}`,
        providerStatus: upstream.status
      }, 502);
    }

    const outputText = extractOutputText(providerPayload);
    if (!outputText) {
      const finishReason = (providerPayload as { candidates?: Array<{ finishReason?: unknown }> }).candidates?.[0]?.finishReason;
      console.error("Gemini returned no generated text.", finishReason);
      return jsonResponse({
        error: `Gemini returned no guide${finishReason ? ` (finish reason: ${String(finishReason)}).` : "."}`
      }, 502);
    }

    let guide: unknown;
    try {
      const jsonText = outputText.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
      guide = JSON.parse(jsonText);
    } catch (error) {
      console.error("Gemini returned malformed study-guide JSON.", error);
      return jsonResponse({ error: "Gemini returned malformed guide JSON." }, 502);
    }
    if (!isStudyGuide(guide)) {
      console.error("Gemini study-guide response failed schema validation.");
      return jsonResponse({ error: "Gemini returned a guide that does not match the required quiz format." }, 502);
    }

    return jsonResponse(guide, 200);
  };
}
