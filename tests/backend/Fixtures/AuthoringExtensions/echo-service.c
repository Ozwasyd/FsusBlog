#include <stdio.h>
#include <string.h>
#include <signal.h>
#include <unistd.h>

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

        /* Base64("DETACH_CHILD"). The child deliberately creates a new
           session and ignores SIGHUP. The host test must still prove that the
           sandbox namespace/process-tree authority removes it. */
        if (strcmp(payload, "REVUQUNIX0NISUxE") == 0)
        {
            pid_t child = fork();
            if (child < 0)
            {
                return 4;
            }
            if (child == 0)
            {
                (void)setsid();
                (void)signal(SIGHUP, SIG_IGN);
                for (;;)
                {
                    sleep(1);
                }
            }
        }

        printf("RESULT\t%s\t%s\t%s\t%s\n", schema, runtime, request, payload);
    }

    return 0;
}
