import express from 'express';
import uniqid from 'uniqid';
import fs from 'fs';
import cors from 'cors';
import puppeteer from 'puppeteer';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from 'ffprobe-static';
import path from 'path';
import OpenAI from 'openai';
import { TextToSpeechClient } from '@google-cloud/text-to-speech';
import speech from '@google-cloud/speech';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import axios from "axios";
import FormData from "form-data";

dotenv.config();
const app = express();
app.use(cors());
app.use(express.static('stories'));

ffmpeg.setFfmpegPath(ffmpegPath);

const ffprobePath = ffprobeStatic.path;
ffmpeg.setFfprobePath(ffprobePath);

// Use environment variables for credentials
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Use environment variable for Google credentials path or use application default credentials
const googleCredentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || path.resolve('./google-credentials.json');

// Check if credentials file exists
if (!fs.existsSync(googleCredentialsPath)) {
  console.warn(`Google credentials file not found at ${googleCredentialsPath}. Audio features may not work.`);
}

const ttsClient = new TextToSpeechClient({
  keyFilename: googleCredentialsPath
});

const sttClient = new speech.SpeechClient({
  keyFilename: googleCredentialsPath
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

// Function to extract key nouns from summary
async function extractKeyNouns(summaryText) {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini-2024-07-18',
      messages: [
        { 
          role: 'system', 
          content: 'Extract exactly three distinct, concrete, visual nouns from the text. Return ONLY these three nouns separated by commas, with no additional text. Choose nouns that would work well as image generation prompts.' 
        }, 
        { 
          role: 'user', 
          content: summaryText 
        }
      ],
      temperature: 0.3,
    });

    const nouns = response.choices[0].message.content.split(',').map(noun => noun.trim());
    
    // Ensure we have exactly 3 nouns
    while (nouns.length < 3) {
      nouns.push(`object${nouns.length + 1}`);
    }
    
    return nouns.slice(0, 3); // Return only the first 3 nouns
  } catch (error) {
    console.error("Error extracting nouns:", error);
    return ["object1", "object2", "object3"]; // Fallback nouns
  }
}

// Image generation uses simple noun-based prompts
// Image generation uses simple noun-based prompts
async function generateImages(summaryText, dir) {
  // Extract key nouns from the summary
  const keyNouns = await extractKeyNouns(summaryText);
  console.log("Extracted key nouns for image generation:", keyNouns);
  
  // Make sure the directory exists
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  
  // Create simple, focused prompts based on individual nouns
  for (let i = 0; i < keyNouns.length; i++) {
    try {
      const noun = keyNouns[i];
      const imagePath = path.join(dir, `b-roll-${i + 1}.webp`);
      
      // Simple, focused prompt for better image generation
      const prompt = `image of ${noun}.`;
      
      console.log(`Generating image ${i + 1} with prompt: "${prompt}"`);
      
      // Configure the payload for Stability AI
      const payload = {
        prompt: prompt,
        output_format: "webp"
      };
      
      // Make the API request to Stability AI
      const response = await axios.postForm(
        `https://api.stability.ai/v2beta/stable-image/generate/ultra`,
        axios.toFormData(payload, new FormData()),
        {
          validateStatus: undefined,
          responseType: "arraybuffer",
          headers: { 
            Authorization: `Bearer ${process.env.STABILITY_API_KEY}`, 
            Accept: "image/*" 
          },
        },
      );
      
      // Handle the response
      if (response.status === 200) {
        fs.writeFileSync(imagePath, Buffer.from(response.data));
        console.log(`Successfully saved image to ${imagePath}`);
      } else {
        console.error(`Error generating image: ${response.status}: ${response.data.toString()}`);
      }
      
    } catch (error) {
      console.error(`Error generating image for noun "${keyNouns[i]}":`, error);
    }
  }
}

// Improved voiceover generation with better error handling
async function generateVoiceover(texts, dir) {
  console.log("Starting voiceover generation for", texts.length, "text segments");
  
  // Combine all texts into one for a single audio file to avoid synchronization issues
  const combinedText = texts.join(" ");
  
  try {
    const request = {
      input: { text: combinedText },
      voice: { languageCode: 'en-US', ssmlGender: 'MALE', name: 'en-US-Standard-B' },
      audioConfig: { 
        audioEncoding: 'MP3',
        speakingRate: 0.9, // Slightly slower for better clarity
        pitch: 0.0,
        volumeGainDb: 1.0
      },
    };
    
    console.log("Sending TTS request for combined text:", combinedText.substring(0, 100) + "...");
    const [response] = await ttsClient.synthesizeSpeech(request);
    
    if (!response.audioContent || response.audioContent.length === 0) {
      throw new Error("Received empty audio content from TTS API");
    }
    
    const mainAudioPath = path.join(dir, 'voiceover-main.mp3');
    fs.writeFileSync(mainAudioPath, response.audioContent);
    console.log(`Saved combined voiceover to ${mainAudioPath} (${response.audioContent.length} bytes)`);
    
    // For compatibility with existing code, also save the main audio as voiceover-1.mp3
    fs.writeFileSync(path.join(dir, 'voiceover-1.mp3'), response.audioContent);
    
    return true;
  } catch (error) {
    console.error("Error generating voiceover:", error);
    
    // Attempt to create a fallback audio file
    try {
      // Check if empty.mp3 exists at the root directory
      const emptyMp3Path = path.resolve('./empty.mp3');
      
      if (fs.existsSync(emptyMp3Path)) {
        // Use the existing empty.mp3 file
        const emptyMp3 = fs.readFileSync(emptyMp3Path);
        fs.writeFileSync(path.join(dir, 'voiceover-main.mp3'), emptyMp3);
        fs.writeFileSync(path.join(dir, 'voiceover-1.mp3'), emptyMp3);
        console.log("Used existing empty.mp3 as fallback audio");
      } else {
        // Create a silent audio file using FFmpeg directly
        await new Promise((resolve, reject) => {
          const silentPath = path.join(dir, 'voiceover-main.mp3');
          ffmpeg()
            .input('anullsrc')
            .inputFormat('lavfi')
            .audioFrequency(44100)
            .duration(15)
            .audioCodec('libmp3lame')
            .audioBitrate('128k')
            .output(silentPath)
            .on('end', () => {
              console.log('Generated silent audio as fallback');
              // Copy to voiceover-1.mp3 as well
              fs.copyFileSync(silentPath, path.join(dir, 'voiceover-1.mp3'));
              resolve();
            })
            .on('error', (err) => {
              console.error('Failed to generate silent audio:', err);
              reject(err);
            })
            .run();
        }).catch(() => {
          // Last resort: create empty files
          fs.writeFileSync(path.join(dir, 'voiceover-main.mp3'), Buffer.from(''));
          fs.writeFileSync(path.join(dir, 'voiceover-1.mp3'), Buffer.from(''));
          console.log("Created empty audio files as last resort");
        });
      }
    } catch (fallbackError) {
      console.error("Failed to create fallback audio:", fallbackError);
      // Create empty files as absolute last resort
      fs.writeFileSync(path.join(dir, 'voiceover-main.mp3'), Buffer.from(''));
      fs.writeFileSync(path.join(dir, 'voiceover-1.mp3'), Buffer.from(''));
    }
    
    return false;
  }
}

async function transcribeAudio(dir) {
  try {
    const filename = 'voiceover-main.mp3';
    const filePath = path.join(dir, filename);
    
    if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
      console.warn("Audio file missing or empty, skipping transcription");
      return false;
    }
    
    const audio = { content: fs.readFileSync(filePath).toString('base64') };
    const config = { 
      encoding: 'MP3', 
      languageCode: 'en-US',
      enableAutomaticPunctuation: true,
      enableWordTimeOffsets: true
    };
    const request = { audio, config };
    
    const [response] = await sttClient.recognize(request);
    
    if (!response.results || response.results.length === 0) {
      throw new Error("No transcription results returned");
    }
    
    fs.writeFileSync(
      path.join(dir, 'transcription-main.json'), 
      JSON.stringify(response.results[0].alternatives[0], null, 2)
    );
    
    // Also save as transcription-1.json for compatibility
    fs.writeFileSync(
      path.join(dir, 'transcription-1.json'), 
      JSON.stringify(response.results[0].alternatives[0], null, 2)
    );
    
    return true;
  } catch (error) {
    console.error("Error transcribing audio:", error);
    return false;
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
      // Scrape and summarize content
      const rawText = await scrapeContent(url);
      const summary = await summarizeText(rawText);
      
      // Ensure we get 3 sentences for the video segments
      let splitText = summary.match(/[^.!?]+[.!?]+/g) || [];
      splitText = splitText.slice(0, 3);
      
    

      // Save text segments
      splitText.forEach((txt, idx) => fs.writeFileSync(`${dir}/story-${idx + 1}.txt`, txt));
      fs.writeFileSync(`${dir}/story-full.txt`, summary);

      // Generate images based on key nouns extracted from the summary
      try {
        await generateImages(summary, dir);
        console.log("Images generated successfully");
      } catch (imageError) {
        console.error("Error generating images:", imageError);
        // Create placeholder files
        for (let i = 0; i < 3; i++) {
          const emptyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
          fs.writeFileSync(path.join(dir, `b-roll-${i + 1}.webp`), emptyPng);
        }
      }

      // Generate and check audio - using a single audio file for the entire video
      let audioSuccess = false;
      try {
        audioSuccess = await generateVoiceover(splitText, dir);
        console.log("Voiceover generation status:", audioSuccess ? "Success" : "Failed");
      } catch (voiceError) {
        console.error("Fatal error in voiceover generation:", voiceError);
      }

      // Only transcribe if audio was successfully generated
      if (audioSuccess) {
        try {
          const transcriptionSuccess = await transcribeAudio(dir);
          console.log("Audio transcription status:", transcriptionSuccess ? "Success" : "Failed");
        } catch (transcribeError) {
          console.error("Error transcribing audio:", transcribeError);
        }
      }

      return res.json({ id: path.basename(dir), audioStatus: audioSuccess });
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
    
    // Use absolute paths to avoid directory-related issues
    const absoluteDir = path.resolve(dir);
    const imageBase = 'b-roll-';
    const audioFile = path.join(absoluteDir, 'voiceover-main.mp3');
    const transcriptionFile = path.join(absoluteDir, 'transcription-main.json');
    
    console.log(`Processing story with ID: ${id} in directory: ${absoluteDir}`);
    
    // Only use the main audio file - no fallbacks
    if (!fs.existsSync(audioFile) || fs.statSync(audioFile).size === 0) {
      console.error("Error: Main audio file missing or empty");
      return res.status(500).json({ error: "Audio file not found or empty" });
    }
    
    console.log("Using main audio file:", audioFile);
    
    // Verify all images exist and create placeholders if needed
    for (let i = 1; i <= 3; i++) {
      const imgPath = path.join(absoluteDir, `${imageBase}${i}.webp`);
      if (!fs.existsSync(imgPath) || fs.statSync(imgPath).size === 0) {
        const emptyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
        fs.writeFileSync(imgPath, emptyPng);
        console.log(`Created placeholder for missing image ${i}`);
      }
    }

    // Get total audio duration
    let totalDuration;
    try {
      totalDuration = await new Promise((resolve, reject) => {
        ffmpeg.ffprobe(audioFile, (err, metadata) => {
          if (err) {
            console.error(`Error getting audio duration:`, err);
            reject(err);
          } else if (!metadata || !metadata.format) {
            console.error(`Invalid metadata returned from ffprobe:`, metadata);
            reject(new Error("Invalid metadata"));
          } else {
            console.log("Audio metadata:", JSON.stringify(metadata.format, null, 2));
            resolve(metadata.format.duration);
          }
        });
      });
    } catch (probeError) {
      console.error("Failed to probe audio file:", probeError);
      return res.status(500).json({ error: "Failed to determine audio duration" });
    }
    
    console.log(`Total audio duration: ${totalDuration} seconds`);
    
    // Create a temporary directory for outputs
    const tempDir = path.join(absoluteDir, 'temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    
    // Generate subtitles file (SRT) from transcription if available
    const subtitleFile = path.join(tempDir, 'subtitles.srt');
    let hasSubtitles = false;
    
    try {
      if (fs.existsSync(transcriptionFile)) {
        const transcription = JSON.parse(fs.readFileSync(transcriptionFile, 'utf8'));
        
        if (transcription && transcription.words && transcription.words.length > 0) {
          console.log("Generating SRT subtitles from transcription");
          
          // Create SRT file
          let srtContent = '';
          let subtitleIndex = 1;
          let currentSubtitle = '';
          let startTime = null;
          let endTime = null;
          let wordCount = 0;
          
          // Process each word
          for (let i = 0; i < transcription.words.length; i++) {
            const word = transcription.words[i];
            const nextWord = i < transcription.words.length - 1 ? transcription.words[i + 1] : null;
            
            // Start a new subtitle if this is the first word
            if (startTime === null) {
              startTime = parseFloat(word.startTime.replace('s', ''));
              currentSubtitle = word.word;
              wordCount = 1;
            } else {
              // Add word to current subtitle
              currentSubtitle += ' ' + word.word;
              wordCount++;
            }
            
            // End the subtitle if we reach 10 words or if there's a long pause or it's the last word
            const endCurrentSubtitle = 
              wordCount >= 10 || 
              !nextWord || 
              (nextWord && (parseFloat(nextWord.startTime.replace('s', '')) - parseFloat(word.endTime.replace('s', '')) > 0.7));
            
            if (endCurrentSubtitle) {
              endTime = parseFloat(word.endTime.replace('s', ''));
              
              // Format times for SRT (00:00:00,000)
              const formatSrtTime = (seconds) => {
                const hrs = Math.floor(seconds / 3600);
                const mins = Math.floor((seconds % 3600) / 60);
                const secs = Math.floor(seconds % 60);
                const ms = Math.floor((seconds % 1) * 1000);
                return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')},${ms.toString().padStart(3, '0')}`;
              };
              
              // Add subtitle to SRT
              srtContent += `${subtitleIndex}\n`;
              srtContent += `${formatSrtTime(startTime)} --> ${formatSrtTime(endTime)}\n`;
              srtContent += `${currentSubtitle.trim()}\n\n`;
              
              // Reset for next subtitle
              subtitleIndex++;
              startTime = null;
              currentSubtitle = '';
              wordCount = 0;
            }
          }
          
          fs.writeFileSync(subtitleFile, srtContent);
          console.log("Generated SRT file:", subtitleFile);
          hasSubtitles = true;
        } else {
          console.warn("Transcription file exists but has no word timing data");
        }
      } else {
        console.warn("Transcription file not found:", transcriptionFile);
      }
    } catch (subtitleError) {
      console.error("Error generating subtitles:", subtitleError);
      // Continue without subtitles if there's an error
    }
    
    // Calculate duration for each segment
    const segmentDuration = totalDuration / 3;
    console.log(`Each image segment will be ${segmentDuration} seconds`);
    
    // Create image segments with portions of the audio - without subtitles first
    for (let i = 0; i < 3; i++) {
      const imageFile = path.join(absoluteDir, `${imageBase}${i+1}.webp`);
      const outputFile = path.join(tempDir, `output_${i}.mp4`);
      const startTime = i * segmentDuration;
      
      console.log(`Processing segment ${i+1}:`);
      console.log(`- Image: ${imageFile}`);
      console.log(`- Output: ${outputFile}`);
      console.log(`- Time range: ${startTime} to ${startTime + segmentDuration}`);
      
      try {
        await new Promise((resolve, reject) => {
          ffmpeg()
            .input(imageFile)
            .inputOptions(['-loop 1'])
            .input(audioFile)
            .inputOptions([`-ss ${startTime}`])
            .outputOptions([
              `-t ${segmentDuration}`,
              '-c:v libx264',
              '-tune stillimage',
              '-pix_fmt yuv420p',
              '-c:a copy',
              '-shortest',
              '-map 0:v:0',  // Map video from first input (image)
              '-map 1:a:0'   // Map audio from second input (audio file)
            ])
            .output(outputFile)
            .on('start', (commandLine) => {
              console.log(`FFmpeg command for segment ${i+1}:`, commandLine);
            })
            .on('end', () => {
              console.log(`Segment ${i+1} created successfully`);
              resolve();
            })
            .on('error', (err) => {
              console.error(`Error creating segment ${i+1}:`, err);
              reject(err);
            })
            .run();
        });
      } catch (segmentError) {
        console.error(`Failed to create segment ${i+1}:`, segmentError);
        return res.status(500).json({ error: `Failed to create video segment ${i+1}` });
      }
    }
    
    // Create a list of segments for concatenation
    const segmentsList = path.join(tempDir, 'segments.txt');
    const segmentsContent = [0, 1, 2]
      .map(i => `file '${path.resolve(path.join(tempDir, `output_${i}.mp4`))}'`)
      .join('\n');

    fs.writeFileSync(segmentsList, segmentsContent);
    console.log("Created segments list:", segmentsList);
    
    // Create concatenated video without subtitles first
    const concatenatedVideo = path.join(tempDir, 'concatenated.mp4');
    
    try {
      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(segmentsList)
          .inputOptions(['-f concat', '-safe 0'])
          .outputOptions([
            '-c copy',
            '-movflags +faststart'
          ])
          .output(concatenatedVideo)
          .on('start', (commandLine) => {
            console.log('FFmpeg concat command:', commandLine);
          })
          .on('end', () => {
            console.log('Concatenated video created successfully');
            resolve();
          })
          .on('error', (err) => {
            console.error('Error creating concatenated video:', err);
            reject(err);
          })
          .run();
      });
      
      // Final video output path
      const finalVideoPath = path.join(absoluteDir, 'final.mp4');
      
      // Add subtitles to the concatenated video if available
      if (hasSubtitles) {
        await new Promise((resolve, reject) => {
          console.log("Adding subtitles to final video");
          
          ffmpeg()
            .input(concatenatedVideo)
            .input(subtitleFile)
            .outputOptions([
              '-c:v copy',
              '-c:a copy',
              '-c:s mov_text',  // Use mov_text codec for MP4 subtitles
              '-metadata:s:s:0 language=eng',  // Set subtitle language
              '-map 0:v:0',
              '-map 0:a:0',
              '-map 1:0',  // Map the subtitle file
              '-movflags +faststart'
            ])
            .output(finalVideoPath)
            .on('start', (commandLine) => {
              console.log('FFmpeg subtitle command:', commandLine);
            })
            .on('end', () => {
              console.log('Final video with subtitles created successfully');
              resolve();
            })
            .on('error', (err) => {
              console.error('Error adding subtitles to final video:', err);
              
              // If adding subtitles fails, fallback to using the concatenated video
              console.log("Falling back to video without subtitles");
              fs.copyFileSync(concatenatedVideo, finalVideoPath);
              resolve();
            })
            .run();
        });
      } else {
        // If no subtitles, just use the concatenated video
        fs.copyFileSync(concatenatedVideo, finalVideoPath);
        console.log("No subtitles available, using concatenated video as final");
      }
      
      // Verify the final video
      const stats = fs.statSync(finalVideoPath);
      console.log(`Final video size: ${stats.size} bytes`);
      
      return res.json({ videoUrl: `${id}/final.mp4` });
    } catch (finalError) {
      console.error("Failed to process final video:", finalError);
      return res.status(500).json({ error: "Failed to create final video" });
    }
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
