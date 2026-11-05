import { Game } from '../src/engine/game.js';
import { RandomAgent } from '../src/ai/agents.js';
const pats = ['Campaign of','wins a vote','Conspiracy in','Peasant revolt in','Crusade in','Jihad in','Reformation in','APOSTASY','coronation with','Old Maid','Trade shift','Inquisitor','Diet of Worms','Pacified','beheads','taxes','is repressed','Corsair','Siege kills','REGIME CHANGE','flips to','becomes a Vassal','Theocracy','Golden Liberty','Emancipated','Levy:','Comet','sells','Victorious','attack fails','assassin','Hand limit','free','Venice discards','Cryptography','returns to its Throne'];
const N=+(process.argv[2]||300); const c={};
for(let g=0;g<N;g++){const game=new Game({seed:5000+g,players:[{name:'A'},{name:'B'}]});const bots=[new RandomAgent(g*3+1),new RandomAgent(g*5+2)];
 let n=0; while(game.request&&n<20000){const r=game.request; game.choose(bots[r.player].choose(game.view,r)); n++;}
 for(const l of game.state.log) for(const p of pats) if(l.includes(p)) c[p]=(c[p]||0)+1;}
for(const p of pats) console.log(p.padEnd(22), c[p]||0);
