#include <stdio.h>
#include <string.h>

int main(int argc, char **argv)
{
    if (argc != 6)
    {
        return 2;
    }

    setvbuf(stdout, NULL, _IOLBF, 0);
    printf("READY\t%s\t%s\t%s\n", argv[1], argv[2], argv[3]);

    char line[65536];
    while (fgets(line, sizeof(line), stdin) != NULL)
    {
        line[strcspn(line, "\r\n")] = '\0';
        char *cursor = NULL;
        char *kind = strtok_r(line, "\t", &cursor);
        char *schema = strtok_r(NULL, "\t", &cursor);
        char *runtime = strtok_r(NULL, "\t", &cursor);
        char *request = strtok_r(NULL, "\t", &cursor);
        char *grants = strtok_r(NULL, "\t", &cursor);
        char *payload = strtok_r(NULL, "\t", &cursor);
        char *extra = strtok_r(NULL, "\t", &cursor);
        if (kind == NULL || strcmp(kind, "EXEC") != 0 || schema == NULL || runtime == NULL ||
            request == NULL || grants == NULL || payload == NULL || extra != NULL)
        {
            return 3;
        }

        printf("RESULT\t%s\t%s\t%s\t%s\n", schema, runtime, request, payload);
    }

    return 0;
}
