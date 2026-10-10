import { PutObjectCommand } from '@aws-sdk/client-s3';
import { s3 } from './client.js';

export const reportKey = ({ school_id, term_id, class_id, checkpoint, student_id, calculation_id }) =>
  `report-cards/${school_id}/${term_id}/${class_id}/${checkpoint}/${student_id}-${calculation_id}.pdf`;

export async function store(key, body) {
  await s3.send(new PutObjectCommand({
    Bucket: process.env.REPORT_BUCKET,
    Key: key,
    Body: body,
    ContentType: 'application/pdf',
  }));
  return { bucket: process.env.REPORT_BUCKET, key };
}