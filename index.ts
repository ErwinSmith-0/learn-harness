import { searchCode } from "./tool-calls/searchCode";

async function main() {
    const results = await searchCode("cookie");
    console.log(results);
}

main().catch(console.error);