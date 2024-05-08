import { DefineFunction, Schema, SlackFunction } from "deno-slack-sdk/mod.ts";
import { SlackAPIClient } from "deno-slack-sdk/types.ts";
import { isDebugMode } from "./internals/debug_mode.ts";

export const def = DefineFunction({
  callback_id: "translate",
  title: "Post the translation of given message as a reply in its thread",
  source_file: "functions/translate.ts",
  input_parameters: {
    properties: {
      channelId: { type: Schema.types.string },
      messageTs: { type: Schema.types.string },
      lang: { type: Schema.types.string },
    },
    required: ["channelId", "messageTs"],
  },
  output_parameters: {
    properties: { ts: { type: Schema.types.string } },
    required: [],
  },
});

export default SlackFunction(def, async ({ inputs, client, env }) => {
  const debugMode = isDebugMode(env);
  if (debugMode) {
    console.log(`translate inputs: ${JSON.stringify(inputs)}`);
  }
  const emptyOutputs = { outputs: {} };
  if (inputs.lang === undefined) {
    // no language specified by the reaction
    console.log("Skipped as no lang detected");
    return emptyOutputs; // this is not an error
  }
  // Fetch the target message to translate
  const translationTargetResponse = await client.conversations.replies({
    channel: inputs.channelId,
    ts: inputs.messageTs,
    limit: 1,
    inclusive: true,
  });
  if (debugMode) {
    console.log(
      `Find the target: ${JSON.stringify(translationTargetResponse)}`,
    );
  }

  if (translationTargetResponse.error) {
    // If you see this log message, perhaps you need to invite this app to the channel
    const error =
      `Failed to fetch the message due to ${translationTargetResponse.error}. Perhaps, you need to invite this app's bot user to the channel.`;
    console.log(error);
    return { error };
  }

  if (translationTargetResponse.messages.length == 0) {
    console.log("No message found");
    return emptyOutputs; // this is not an error
  }
  const translationTarget = translationTargetResponse.messages[0];
  const translationTargetThreadTs = translationTarget.thread_ts;

  const openaiApiKey = env.OPENAI_API_KEY;
  if (!openaiApiKey) {
    const error =
      "OPENAI_API_KEY needs to be set. You can place .env file for local dev. For production apps, please run `slack env add OPENAI_API_KEY (your key here)` to set the value.";
    return { error };
  }

  const body = {
    model: "text-davinci-003",
    prompt: `Translate this text to ${inputs.lang.toUpperCase()}: "${translationTarget.text}"`,
    temperature: 0.5,
    max_tokens: 200,
  };

  const openaiResponse = await fetch("https://api.openai.com/v1/engines/text-davinci-003/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Authorization": `Bearer ${openaiApiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (openaiResponse.status != 200) {
    const error = `Translating a message failed! Please make sure if the OPENAI_API_KEY is correct. - (status: ${openaiResponse.status}, target text: ${translationTarget.text.substring(0, 30)}...)`;
    console.log(error);
    return { error };
  }
  const translationResult = await openaiResponse.json();
  if (debugMode) {
    console.log(`translation result: ${JSON.stringify(translationResult)}`);
  }

  if (!translationResult || !translationResult.choices || translationResult.choices.length === 0) {
    const printableResponse = JSON.stringify(translationResult);
    const error = `Translating a message failed! Contact the app maintainers with the following information - (OpenAI API response: ${printableResponse})`;
    console.log(error);
    return { error };
  }
  const translatedText = translationResult.choices[0].text;

  const replies = await client.conversations.replies({
    channel: inputs.channelId,
    ts: translationTargetThreadTs ?? inputs.messageTs,
  });
  if (isAlreadyPosted(replies.messages, translatedText)) {
    // Skip posting the same one
    console.log(
      `Skipped this translation as it's already posted: ${
        JSON.stringify(
          translatedText,
        )
      }`,
    );
    return emptyOutputs; // this is not an error
  }
  const result = await sayInThread(
    client,
    inputs.channelId,
    translationTargetThreadTs ?? inputs.messageTs,
    translatedText,
  );
  return { outputs: { ts: result.ts } };
});

// ---------------------------
// Internal functions
// ---------------------------

function isAlreadyPosted(
  // deno-lint-ignore no-explicit-any
  replies: Record<string, any>[],
  translatedText: string,
): boolean {
  if (!replies) {
    return false;
  }
  for (const messageInThread of replies) {
    if (messageInThread.text && messageInThread.text === translatedText) {
      return true;
    }
  }
  return false;
}

async function sayInThread(
  client: SlackAPIClient,
  channelId: string,
  threadTs: string,
  text: string,
) {
  return await client.chat.postMessage({
    channel: channelId,
    text,
    thread_ts: threadTs,
  });
}
