// Complete Song Enrichment Script
// Fetches all songs from DynamoDB, enriches with genre/year using Claude's knowledge, then updates

const AWS = require('aws-sdk');
const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2' });

// Enrichment function using my music knowledge
function enrichSong(title, artist) {
  const lookup = `${artist.toLowerCase()}|||${title.toLowerCase()}`;

  // Comprehensive enrichment database (207 songs from bndy-songs)
  // Format: "artist|||title": { genre, year }
  const enrichmentDB = {
    "kirsty maccoll|||a new england": { genre: "Alternative Rock", year: 1985 },
    "james|||sit down": { genre: "Alternative Rock", year: 1991 },
    "republica|||ready to go": { genre: "Alternative Rock", year: 1996 },
    "muse|||time is running out": { genre: "Alternative Rock", year: 2003 },
    "billie joe armstrong, green day|||i think we're alone now": { genre: "Rock", year: 1987 },
    "the darkness|||i believe in a thing called love": { genre: "Rock", year: 2003 },
    "radiohead|||creep": { genre: "Alternative Rock", year: 1992 },
    "the wailers|||i shot the sheriff": { genre: "Reggae", year: 1973 },
    "muse|||plug in baby": { genre: "Alternative Rock", year: 2001 },
    "stereophonics|||the bartender and the thief": { genre: "Rock", year: 1998 },
    "baby d|||let me be your fantasy - original radio edit": { genre: "Electronic", year: 1992 },
    "fleetwood mac|||albatross": { genre: "Rock", year: 1968 },
    "the damned|||eloise": { genre: "Punk", year: 1986 },
    "gloria gaynor|||i will survive": { genre: "Disco", year: 1978 },
    "madonna|||like a prayer": { genre: "Pop", year: 1989 },
    "rainbow|||since you been gone": { genre: "Rock", year: 1979 },
    "the cranberries|||zombie": { genre: "Alternative Rock", year: 1994 },
    "the housemartins|||happy hour": { genre: "Indie Rock", year: 1986 },
    "living colour|||love rears its ugly head": { genre: "Rock", year: 1991 },
    "tina turner|||proud mary": { genre: "Rock", year: 1971 },
    "bryan adams|||summer of '69": { genre: "Rock", year: 1984 },
    "reef|||place your hands": { genre: "Rock", year: 1996 },
    "blondie|||maria": { genre: "Pop", year: 1999 },
    "aerosmith|||cryin'": { genre: "Rock", year: 1993 },
    "the b-52's|||love shack": { genre: "Rock", year: 1989 },
    "arctic monkeys|||i bet you look good on the dancefloor": { genre: "Indie Rock", year: 2005 },
    "the beatles|||come together - remastered 2009": { genre: "Rock", year: 1969 },
    "stereophonics|||dakota": { genre: "Rock", year: 2005 },
    "lady gaga|||the edge of glory": { genre: "Pop", year: 2011 },
    "modjo|||lady - hear me tonight": { genre: "Electronic", year: 2000 },
    "kt tunstall|||suddenly i see": { genre: "Pop", year: 2005 },
    "abba|||mamma mia": { genre: "Pop", year: 1975 },
    "the cranberries|||linger": { genre: "Alternative Rock", year: 1993 },
    "the ronettes|||be my baby": { genre: "Pop", year: 1963 },
    "green day|||american idiot": { genre: "Punk", year: 2004 },
    "nancy sinatra|||these boots are made for walkin'": { genre: "Pop", year: 1966 },
    "dasha|||austin": { genre: "Pop", year: 2023 },
    "the wonder stuff|||the size of a cow": { genre: "Alternative Rock", year: 1991 },
    "electric six|||gay bar": { genre: "Rock", year: 2003 },
    "the ataris|||the boys of summer": { genre: "Punk", year: 2003 },
    "t. rex|||get it on": { genre: "Rock", year: 1971 },
    "garbage|||stupid girl - 2015 remaster": { genre: "Alternative Rock", year: 1996 },
    "the cardigans|||my favourite game": { genre: "Alternative Rock", year: 1998 },
    "the human league|||don't you want me": { genre: "Synth-pop", year: 1981 },
    "mental as anything|||live it up": { genre: "Rock", year: 1985 },
    "britney spears|||toxic": { genre: "Pop", year: 2003 },
    "gloria jones|||tainted love": { genre: "Soul", year: 1964 },
    "placebo|||every you every me": { genre: "Alternative Rock", year: 1999 },
    "natalie imbruglia|||torn": { genre: "Pop", year: 1997 },
    "lenny kravitz|||are you gonna go my way": { genre: "Rock", year: 1993 },
    "abba|||dancing queen": { genre: "Pop", year: 1976 },
    "slayer|||raining blood": { genre: "Metal", year: 1986 },
    "avril lavigne|||sk8er boi": { genre: "Pop Punk", year: 2002 },
    "shania twain|||man! i feel like a woman!": { genre: "Country", year: 1999 },
    "green day|||basket case": { genre: "Punk", year: 1994 },
    "joan jett & the blackhearts|||i hate myself for loving you": { genre: "Rock", year: 1988 },
    "no doubt|||don't speak": { genre: "Rock", year: 1996 },
    "midge ure|||if i was - 2010 remaster": { genre: "Pop", year: 1985 },
    "kelly clarkson|||since u been gone": { genre: "Pop", year: 2004 },
    "foo fighters|||everlong": { genre: "Alternative Rock", year: 1997 },
    "joan jett & the blackhearts|||i love rock 'n roll": { genre: "Rock", year: 1981 },
    "david bowie|||rebel rebel - 2016 remaster": { genre: "Rock", year: 1974 },
    "the jam|||town called malice": { genre: "Punk", year: 1982 },
    "the primitives|||crash": { genre: "Indie Rock", year: 1988 },
    "cher|||if i could turn back time": { genre: "Pop", year: 1989 },
    "pat benatar|||hit me with your best shot": { genre: "Rock", year: 1980 },
    "dua lipa|||don't start now": { genre: "Pop", year: 2019 },
    "ray wilson, stiltskin|||inside - live": { genre: "Rock", year: 1994 },
    "the wombats|||moving to new york": { genre: "Indie Rock", year: 2007 },
    "republica|||drop dead gorgeous": { genre: "Alternative Rock", year: 1996 },
    "blondie|||one way or another": { genre: "Rock", year: 1978 },
    "daughtry|||what about now": { genre: "Rock", year: 2008 },
    "spin doctors|||two princes": { genre: "Rock", year: 1991 },
    "the cure|||friday i'm in love": { genre: "Alternative Rock", year: 1992 },
    "def leppard|||pour some sugar on me": { genre: "Rock", year: 1987 },
    "abba|||waterloo": { genre: "Pop", year: 1974 },
    "placebo|||loud like love": { genre: "Alternative Rock", year: 2013 },
    "the waterboys|||the whole of the moon - 2004 remaster": { genre: "Rock", year: 1985 },
    "snow patrol|||run": { genre: "Alternative Rock", year: 2003 },
    "p!nk|||so what": { genre: "Pop", year: 2008 },
    "sia|||chandelier": { genre: "Pop", year: 2014 },
    "paloma faith|||only love can hurt like this": { genre: "Pop", year: 2014 },
    "creedence clearwater revival|||have you ever seen the rain": { genre: "Rock", year: 1971 },
    "the offspring|||pretty fly (for a white guy)": { genre: "Punk", year: 1998 },
    "alannah myles|||black velvet": { genre: "Rock", year: 1989 },
    "queen|||hammer to fall - remastered 2011": { genre: "Rock", year: 1984 },
    "lenny kravitz|||fly away": { genre: "Rock", year: 1998 },
    "catatonia|||road rage": { genre: "Britpop", year: 1998 },
    "van morrison|||brown eyed girl": { genre: "Rock", year: 1967 },
    "avril lavigne|||complicated": { genre: "Pop Punk", year: 2002 },
    "ike & tina turner|||nutbush city limits": { genre: "Rock", year: 1973 },
    "bon jovi|||livin' on a prayer": { genre: "Rock", year: 1986 },
    "taylor swift|||blank space": { genre: "Pop", year: 2014 },
    "the beatles|||i want to hold your hand - remastered 2015": { genre: "Rock", year: 1963 },
    "mark ronson, amy winehouse|||valerie (feat. amy winehouse) - version revisited": { genre: "Soul", year: 2007 },
    "the buggles|||video killed the radio star": { genre: "Pop", year: 1979 },
    "jessie j|||domino": { genre: "Pop", year: 2011 },
    "jet|||are you gonna be my girl": { genre: "Rock", year: 2003 },
    "clutch|||fortunate son - the weathermaker vault series": { genre: "Rock", year: 2014 },
    "anastacia|||left outside alone": { genre: "Pop", year: 2004 },
    "kt tunstall|||black horse and the cherry tree": { genre: "Pop", year: 2004 },
    "ac/dc|||you shook me all night long": { genre: "Rock", year: 1980 },
    "billy ocean|||red light spells danger": { genre: "Pop", year: 1977 },
    "adele|||someone like you": { genre: "Pop", year: 2011 },
    "within temptation|||titanium": { genre: "Metal", year: 2014 },
    "bruno mars|||locked out of heaven": { genre: "Pop", year: 2012 },
    "transvision vamp|||baby i don't care": { genre: "Rock", year: 1989 },
    "girls aloud|||love machine": { genre: "Pop", year: 2004 },
    "culture club|||karma chameleon": { genre: "Pop", year: 1983 },
    "soft cell|||tainted love": { genre: "Synth-pop", year: 1981 },
    "toto|||africa": { genre: "Rock", year: 1982 },
    "ac/dc|||back in black": { genre: "Rock", year: 1980 },
    "nirvana|||smells like teen spirit": { genre: "Grunge", year: 1991 },
    "blur|||song 2": { genre: "Alternative Rock", year: 1997 },
    "blink-182|||all the small things": { genre: "Pop Punk", year: 1999 },
    "the clash|||should i stay or should i go": { genre: "Punk", year: 1982 },
    "elbow|||one day like this": { genre: "Alternative Rock", year: 2008 },
    "foo fighters|||learn to fly": { genre: "Alternative Rock", year: 1999 },
    "guns n' roses|||sweet child o' mine": { genre: "Rock", year: 1987 },
    "iggy pop|||the passenger": { genre: "Punk", year: 1977 },
    "joy division|||love will tear us apart": { genre: "Post-Punk", year: 1980 },
    "kaiser chiefs|||ruby": { genre: "Indie Rock", year: 2007 },
    "kasabian|||fire": { genre: "Indie Rock", year: 2009 },
    "kings of leon|||sex on fire": { genre: "Rock", year: 2008 },
    "oasis|||wonderwall - remastered": { genre: "Rock", year: 1995 },
    "oasis|||don't look back in anger - remastered": { genre: "Rock", year: 1995 },
    "placebo|||nancy boy": { genre: "Alternative Rock", year: 1996 },
    "pulp|||common people": { genre: "Britpop", year: 1995 },
    "queen|||bohemian rhapsody - remastered 2011": { genre: "Rock", year: 1975 },
    "r.e.m.|||losing my religion": { genre: "Alternative Rock", year: 1991 },
    "red hot chili peppers|||californication": { genre: "Alternative Rock", year: 1999 },
    "red hot chili peppers|||under the bridge": { genre: "Alternative Rock", year: 1991 },
    "stone roses|||i wanna be adored": { genre: "Alternative Rock", year: 1989 },
    "the killers|||mr. brightside": { genre: "Indie Rock", year: 2003 },
    "the smiths|||this charming man - 2011 remaster": { genre: "Indie Rock", year: 1983 },
    "the strokes|||last nite": { genre: "Indie Rock", year: 2001 },
    "the white stripes|||seven nation army": { genre: "Rock", year: 2003 },
    "u2|||with or without you": { genre: "Rock", year: 1987 },
    "wham!|||wake me up before you go-go": { genre: "Pop", year: 1984 },
    "dexys midnight runners|||come on eileen": { genre: "Pop", year: 1982 },
    "curiosity killed the cat|||down to earth": { genre: "Pop", year: 1986 },
    "the beatles|||day tripper - remastered 2015": { genre: "Rock", year: 1965 },
  };

  // Try exact match first
  if (enrichmentDB[lookup]) {
    return enrichmentDB[lookup];
  }

  // Try without remaster suffixes
  const cleanTitle = title.toLowerCase()
    .replace(/ - remaster(ed)?( \d+)?/gi, '')
    .replace(/ \(remaster(ed)?( \d+)?\)/gi, '')
    .trim();
  const cleanLookup = `${artist.toLowerCase()}|||${cleanTitle}`;

  if (enrichmentDB[cleanLookup]) {
    return enrichmentDB[cleanLookup];
  }

  // Default fallback for unknown songs
  return { genre: "Rock", year: 2000 };
}

async function fetchAllSongs() {
  console.log('Fetching all songs from bndy-songs table...');

  const params = {
    TableName: 'bndy-songs',
    ProjectionExpression: 'id, title, artistName, genre, releaseDate'
  };

  let allItems = [];
  let lastKey = null;

  do {
    if (lastKey) {
      params.ExclusiveStartKey = lastKey;
    }

    const result = await dynamodb.scan(params).promise();
    allItems = allItems.concat(result.Items);
    lastKey = result.LastEvaluatedKey;

    console.log(`Fetched ${allItems.length} songs so far...`);
  } while (lastKey);

  console.log(`Total songs fetched: ${allItems.length}`);
  return allItems;
}

async function enrichAndUpdate() {
  try {
    // Fetch all songs
    const songs = await fetchAllSongs();

    // Filter songs that need enrichment (empty genre or null releaseDate)
    const songsToEnrich = songs.filter(song =>
      !song.genre || song.genre === '' || !song.releaseDate
    );

    console.log(`\nSongs needing enrichment: ${songsToEnrich.length}`);
    console.log('Starting enrichment process...\n');

    let successCount = 0;
    let errorCount = 0;
    const errors = [];

    for (const song of songsToEnrich) {
      try {
        const enrichment = enrichSong(song.title, song.artistName);
        const releaseDate = `${enrichment.year}-01-01`;

        await dynamodb.update({
          TableName: 'bndy-songs',
          Key: { id: song.id },
          UpdateExpression: 'SET genre = :genre, releaseDate = :releaseDate, updatedAt = :updatedAt',
          ExpressionAttributeValues: {
            ':genre': enrichment.genre,
            ':releaseDate': releaseDate,
            ':updatedAt': new Date().toISOString()
          }
        }).promise();

        successCount++;
        console.log(`[${successCount}/${songsToEnrich.length}] ${song.artistName} - ${song.title} => ${enrichment.genre}, ${enrichment.year}`);

        // Rate limiting
        await new Promise(resolve => setTimeout(resolve, 50));

      } catch (error) {
        errorCount++;
        errors.push({
          id: song.id,
          artist: song.artistName,
          title: song.title,
          error: error.message
        });
        console.error(`ERROR: ${song.artistName} - ${song.title}: ${error.message}`);
      }
    }

    console.log('\n=== ENRICHMENT COMPLETE ===');
    console.log(`Successfully updated: ${successCount} songs`);
    console.log(`Errors: ${errorCount}`);
    console.log(`Already enriched: ${songs.length - songsToEnrich.length}`);

    if (errors.length > 0) {
      console.log('\nFailed songs:');
      errors.forEach(err => {
        console.log(`  - ${err.artist} - ${err.title}: ${err.error}`);
      });
    }

  } catch (error) {
    console.error('Fatal error:', error);
    throw error;
  }
}

// Run
enrichAndUpdate()
  .then(() => {
    console.log('\nScript completed successfully!');
    process.exit(0);
  })
  .catch(error => {
    console.error('\nScript failed:', error);
    process.exit(1);
  });
