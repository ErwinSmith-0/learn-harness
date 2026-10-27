import { searchCode } from "../tools/searchCode";

async function main() {
    const results = await searchCode("cookie");
    console.log(results);
}

main().catch(console.error);