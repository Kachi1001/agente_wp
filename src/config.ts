import dotenv from 'dotenv';
dotenv.config();
const base = `http://${process.env.HOST || 'localhost'}:${process.env.PORT || 3005}`;
export const config = {
  port: process.env.PORT || 3005,
  baseUrl: base
};
