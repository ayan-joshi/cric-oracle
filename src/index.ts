import express from 'express';
import cors from 'cors';
import path from 'path';
import dotenv from 'dotenv';
import crawlRouter from './routes/crawl';
import queryRouter from './routes/query';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

app.use('/crawl', crawlRouter);
app.use('/query', queryRouter);

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, () => {
  console.log(`CricOracle running at http://localhost:${PORT}`);
});
