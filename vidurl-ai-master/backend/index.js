import express from 'express';
import uniqid from 'uniqid';
import fs from 'fs';
import cors from 'cors';
import puppeteer from 'puppeteer';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from 'ffprobe-static';
import path from 'path';
import  OpenAI from 'openai';
import { TextToSpeechClient } from '@google-cloud/text-to-speech';
import speech from '@google-cloud/speech';
import dotenv from 'dotenv';
import fetch from 'node-fetch';


dotenv.config();
const app = express();
app.use(cors());
app.use(express.static('stories'));

ffmpeg.setFfmpegPath(ffmpegPath);

const ffprobePath = ffprobeStatic.path;
ffmpeg.setFfprobePath(ffprobePath);


const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const ttsClient = new TextToSpeechClient({
  keyFilename: 'C:\\Users\\HP\\Downloads\\aiv\\aiv\\backend\\hypnotic-trees-453820-e5-faff566b7882.json'
});
const sttClient = new speech.SpeechClient({
    keyFilename: 'C:\\Users\\HP\\Downloads\\aiv\\aiv\\backend\\hypnotic-trees-453820-e5-faff566b7882.json'

});


app.get('/test', (req, res) => {
  return res.json('test ok');
});

async function scrapeContent(url) {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  
  const text = await page.evaluate(() => document.body.innerText);
  await browser.close();
  
  return text;
}

async function summarizeText(text) {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini-2024-07-18',
    messages: [{ role: 'system', content: 'Summarize this text for a short social media video (max 100 words, no emojis):' }, { role: 'user', content: text }],
    temperature: 0.7,
  });

  return response.choices[0].message.content.trim();
}

async function generateImages(summaryText, dir) {
  // Create more descriptive prompts based on the whole summary
  const imagePrompts = [
    `High quality social media visual representing: "${summaryText}". Professional photography style, clear subject, vibrant colors, good lighting, social media friendly format.`,
    `Modern illustration about: "${summaryText}". Clean design, minimalist style, visually appealing for social media, professional quality.`,
    `Engaging visual content showing: "${summaryText}". Eye-catching design, suitable for social media sharing, high resolution quality.`
  ];

  for (let i = 0; i < imagePrompts.length; i++) {
    try {
      const imagePath = path.join(dir, `b-roll-${i + 1}.png`);
      const response = await openai.images.generate({
        prompt: imagePrompts[i],
        n: 1,
        size: '1024x1024',
        quality: "hd" // Request higher quality if supported
      });
      
      // Get the image URL from the response
      const imageUrl = response.data[0].url;
      
      // Download the image and save it
      const imageResponse = await fetch(imageUrl);
      const imageBuffer = await imageResponse.arrayBuffer();
      fs.writeFileSync(imagePath, Buffer.from(imageBuffer));
      
      console.log(`Generated image ${i + 1} saved to ${imagePath}`);
    } catch (error) {
      console.error(`Error generating image ${i + 1}:`, error);
      // Create a placeholder image if generation fails
      fs.writeFileSync(path.join(dir, `b-roll-${i + 1}.png`), Buffer.from(''));
    }
  }
}

async function generateVoiceover(texts, dir) {
  for (let i = 0; i < texts.length; i++) {
    const request = {
      input: { text: texts[i] },
      voice: { languageCode: 'en-US', ssmlGender: 'MALE' },
      audioConfig: { audioEncoding: 'MP3' },
    };
    
    const [response] = await ttsClient.synthesizeSpeech(request);
    fs.writeFileSync(path.join(dir, `voiceover-${i + 1}.mp3`), response.audioContent);
  }
}

async function transcribeAudio(dir, count) {
  for (let i = 0; i < count; i++) {
    const filename = `voiceover-${i + 1}.mp3`;
    const filePath = path.join(dir, filename);
    
    const audio = { content: fs.readFileSync(filePath).toString('base64') };
    const config = { encoding: 'MP3', languageCode: 'en-US' };
    const request = { audio, config };
    
    const [response] = await sttClient.recognize(request);
    fs.writeFileSync(path.join(dir, `transcription-${i + 1}.json`), JSON.stringify(response.results[0].alternatives[0], null, 2));
  }
}

app.get('/create-story', async (req, res) => {
  try {
    const url = decodeURIComponent(req.query.url);
    if (!url) {
      return res.status(400).json({ error: 'Missing URL parameter' });
    }

    const dir = `./stories/${uniqid()}`;
    fs.mkdirSync(dir, { recursive: true });

    console.log(`Processing URL: ${url}`);

    try {
      const rawText = await scrapeContent(url);
      const summary = await summarizeText(rawText);
      const splitText = summary.match(/[^.]+\.?/g).slice(0, 3);

      // Make sure we have at least 3 sentences
      while (splitText.length < 3) {
        splitText.push("This is a placeholder sentence for the video.");
      }

      splitText.forEach((txt, idx) => fs.writeFileSync(`${dir}/story-${idx + 1}.txt`, txt));

      // Process each step separately to prevent one failure from stopping everything
      try {
        await generateImages(summary, dir);
        console.log("Images generated successfully");
      } catch (imageError) {
        console.error("Error generating images:", imageError);
        // Create placeholder files
        for (let i = 0; i < 3; i++) {
          fs.writeFileSync(path.join(dir, `b-roll-${i + 1}.png`), Buffer.from(''));
        }
      }

      try {
        await generateVoiceover(splitText, dir);
        console.log("Voiceovers generated successfully");
      } catch (voiceError) {
        console.error("Error generating voiceovers:", voiceError);
        // Create placeholder audio files
        for (let i = 0; i < 3; i++) {
          fs.writeFileSync(path.join(dir, `voiceover-${i + 1}.mp3`), Buffer.from(''));
        }
      }

      try {
        await transcribeAudio(dir, 3);
        console.log("Audio transcription completed");
      } catch (transcribeError) {
        console.error("Error transcribing audio:", transcribeError);
        // Create placeholder transcription files
        for (let i = 0; i < 3; i++) {
          fs.writeFileSync(
            path.join(dir, `transcription-${i + 1}.json`), 
            JSON.stringify({
              transcript: splitText[i] || "Placeholder text.",
              words: []
            })
          );
        }
      }

      return res.json({ id: path.basename(dir) });
    } catch (processingError) {
      console.error("Error processing content:", processingError);
      return res.status(500).json({ error: processingError.message });
    }
  } catch (e) {
    console.error('Error in create-story:', e);
    return res.status(500).json({ error: e.message });
  }
});

app.get('/build-video', async (req, res) => {
  try {
    const id = req.query.id;
    if (!id) {
      return res.status(400).json({ error: 'Missing ID parameter' });
    }

    const dir = `./stories/${id}`;
    
    // Check if directory exists
    if (!fs.existsSync(dir)) {
      return res.status(404).json({ error: `Story with ID ${id} not found` });
    }
    
    // Check for required files before processing
    const imageBase = 'b-roll-';
    const audioFile = path.join(dir, 'voiceover-1.mp3');
    
    // Check if the first audio file exists
    if (!fs.existsSync(audioFile)) {
      return res.status(404).json({ 
        error: `Missing required audio file for story ${id}. Try recreating the story.` 
      });
    }
    
    // Check if all three images exist
    for (let i = 1; i <= 3; i++) {
      const imgPath = path.join(dir, `${imageBase}${i}.png`);
      if (!fs.existsSync(imgPath)) {
        return res.status(404).json({ 
          error: `Missing required image file ${i} for story ${id}. Try recreating the story.` 
        });
      }
    }

    // Get total audio duration
    const totalDuration = await new Promise((resolve) => {
      ffmpeg.ffprobe(audioFile, (err, metadata) => {
        if (err) {
          console.error(`Error getting audio duration:`, err);
          resolve(15); // Default 15 seconds if can't determine
        } else {
          resolve(metadata.format.duration || 15);
        }
      });
    });
    
    console.log(`Total audio duration: ${totalDuration} seconds`);
    
    // Calculate duration for each image segment (equal thirds)
    const segmentDuration = totalDuration / 3;
    console.log(`Each image segment will be ${segmentDuration} seconds`);
    
    // Process each image segment
    for (let i = 0; i < 3; i++) {
      const imageFile = path.join(dir, `${imageBase}${i+1}.png`);
      const outputFile = path.join(dir, `output_${i}.mp4`);
      const startTime = i * segmentDuration;
      
      console.log(`Processing segment ${i+1}: ${startTime} to ${startTime + segmentDuration}`);
      
      // Create video segment with image and the portion of the audio
      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(imageFile)
          .inputOptions(['-loop 1'])
          .input(audioFile)
          .inputOptions([`-ss ${startTime}`])
          .outputOptions([
            `-t ${segmentDuration}`,
            '-c:a aac',
            '-c:v libx264',
            '-pix_fmt yuv420p',
            '-shortest'
          ])
          .output(outputFile)
          .on('end', () => {
            console.log(`Segment ${i+1} created`);
            resolve();
          })
          .on('error', (err) => {
            console.error(`Error creating segment ${i+1}:`, err);
            reject(err);
          })
          .run();
      });
    }
    
    // Create a list of segments for concatenation
    const segmentsList = path.join(dir, 'segments.txt');
    const segmentsContent = [0, 1, 2]
      .map(i => `file 'output_${i}.mp4'`)
      .join('\n');

    fs.writeFileSync(segmentsList, segmentsContent);
    
    // Change working directory before running ffmpeg
    const currentDir = process.cwd();
    process.chdir(dir);

    await new Promise((resolve, reject) => {
      ffmpeg()
        .input('segments.txt')
        .inputOptions(['-f concat', '-safe 0'])
        .outputOptions(['-c copy'])
        .output('final.mp4')
        .on('end', () => {
          console.log('Final video created');
          process.chdir(currentDir);
          resolve();
        })
        .on('error', (err) => {
          console.error('Error creating final video:', err);
          process.chdir(currentDir);
          reject(err);
        })
        .run();
    });
    
    return res.json({ videoUrl: `${id}/final.mp4` });
  } catch (e) {
    console.error('Error in build-video:', e);
    return res.status(500).json({ error: e.message });
  }
});

app.get('/samples', (req, res) => {
  const stories = fs.readdirSync('./stories').filter(dir => fs.existsSync(`./stories/${dir}/final.mp4`));
  res.json(stories);
});

app.listen(8080, () => console.log('Listening on port 8080'));
