// Serialize native runner events before consumer stdout can be interpreted as evidence.
export default async function* report(source)
{
    for await (const event of source)
    {
        yield `${JSON.stringify(event)}\n`;
    }
}
