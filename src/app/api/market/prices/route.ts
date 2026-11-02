import { NextResponse } from "next/server";
import { getTokenPrices } from "@/features/market/lib/price-provider";

export const revalidate = 60;

export async function GET() {
  const prices = await getTokenPrices();
  return NextResponse.json({
    prices,
    updatedAt: new Date().toISOString()
  });
}
