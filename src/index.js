import { createClient } from '@supabase/supabase-js';

export default {
	async scheduled(request, env, ctx) {
		const supabaseUrl = env.SUPABASE_URL;
		const supabaseKey = env.SUPABASE_API_KEY;
		const supabase = createClient(supabaseUrl, supabaseKey);
		await main(supabase);
		return new Response('Success', { status: 200 });
	},
};

async function updateOldestWordCreatedAt(supabase, difficulty, syllableMin = null, syllableMax = null) {
	let query = supabase.from('spellol_daily').select('id, created_at');

	if (difficulty) query = query.eq('difficulty', difficulty);
	if (syllableMin !== null) query = query.gte('syllable', syllableMin);
	if (syllableMax !== null) query = query.lte('syllable', syllableMax);

	const { data, error } = await query.order('created_at', { ascending: true }).limit(1);

	if (data && data.length > 0) {
		const oldestId = data[0].id;
		const currentDateTime = new Date().toISOString();
		const { data: updateData, error: updateError } = await supabase
			.from('spellol_daily')
			.update({ created_at: currentDateTime })
			.eq('id', oldestId);

		return { data: updateData, error: updateError };
	}
}

async function fetchIdsByDifficulty(supabase, difficulty) {
	const { data } = await supabase.from('spellol_dictionary').select('id').eq('difficulty', difficulty).neq('openai_audio', null);

	return data ? data.map((row) => row.id) : [];
}

async function fetchWordsByIds(supabase, selectedIds) {
	let words = [];
	for (const wordId of selectedIds) {
		const { data, error } = await supabase
			.from('spellol_dictionary')
			.select('word, openai_audio, syllable, difficulty')
			.eq('id', wordId)
			.neq('openai_audio', null);

		if (data) words = words.concat(data);
	}
	return words;
}

async function wordExistsInDaily(supabase, word) {
	const { data, error } = await supabase.from('spellol_daily').select('id').eq('word', word);

	return data && data.length > 0;
}

async function fetchRandomWordsByDifficulty(supabase, difficulty, count) {
	const ids = await fetchIdsByDifficulty(supabase, difficulty);
	let words = [];
	while (words.length < count && ids.length > 0) {
		const randomIndex = Math.floor(Math.random() * ids.length);
		const wordId = ids.splice(randomIndex, 1)[0];
		const wordData = await fetchWordsByIds(supabase, [wordId]);
		if (wordData.length > 0 && !(await wordExistsInDaily(supabase, wordData[0].word))) {
			words = words.concat(wordData);
		}
	}

	if (words.length === 0) {
		await updateOldestWordCreatedAt(supabase, difficulty);
	}

	return words;
}

async function fetchWords(supabase, difficulty, count, syllableMin = null, syllableMax = null) {
	let query = supabase
		.from('spellol_dictionary')
		.select('word, openai_audio, syllable, difficulty')
		.eq('difficulty', difficulty)
		.neq('openai_audio', null);

	if (syllableMin !== null) query = query.gte('syllable', syllableMin);
	if (syllableMax !== null) query = query.lte('syllable', syllableMax);

	const { data, error } = await query;

	let allWords = data || [];
	let selectedWords = [];
	let attempts = 0;

	while (selectedWords.length < count && attempts < 50 && allWords.length > 0) {
		// Randomly select a word
		const randomIndex = Math.floor(Math.random() * allWords.length);
		const selectedWord = allWords[randomIndex];

		// Check if the selected word exists in the daily list
		const existsInDaily = await wordExistsInDaily(supabase, selectedWord.word);

		if (!existsInDaily) {
			selectedWords.push(selectedWord);
			allWords.splice(randomIndex, 1); // Remove the selected word from allWords
		}

		attempts++;
	}

	// If after 50 attempts we don't have enough words, optionally you can update the oldest word's created_at or handle the shortage as needed
	if (selectedWords.length < count) {
		await updateOldestWordCreatedAt(supabase, difficulty, syllableMin, syllableMax);
	}

	return selectedWords.slice(0, count); // Ensure that only the requested number of words are returned
}

async function main(supabase) {
	const words = [
		...(await fetchRandomWordsByDifficulty(supabase, 'easy', 2)),
		...(await fetchRandomWordsByDifficulty(supabase, 'medium', 3)),
		...(await fetchWords(supabase, 'difficult', 2, 1, 2)),
		...(await fetchWords(supabase, 'difficult', 2, 3, 4)),
		...(await fetchWords(supabase, 'difficult', 1, 5, 10)),
	];

	// Print and save words
	for (const word of words) {
		console.log(word.word, word.openai_audio, word.syllable, word.difficulty);
		const currentDateTimeUTC = new Date().toISOString();
		const { data: insertData, error: insertError } = await supabase.from('spellol_daily').insert([
			{
				word: word.word,
				openai_audio: word.openai_audio,
				syllable: word.syllable,
				difficulty: word.difficulty,
				created_at: currentDateTimeUTC,
			},
		]);
	}
}
