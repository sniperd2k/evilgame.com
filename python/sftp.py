import paramiko

def main():
    print("Hello World!")
    paramiko.util.log_to_file("paramiko.log")

    # Open a transport
    host,port = "test.rebex.net",22
    transport = paramiko.Transport((host,port))

    # Auth    
    username,password = "demo","password"
    transport.connect(None,username,password)

    # Go!    
    sftp = paramiko.SFTPClient.from_transport(transport)

    for i in sftp.listdir():
        lstatout=str(sftp.lstat(i)).split()[0]
        print(lstatout)

    # Download
    #filepath = "/etc/passwd"
    #localpath = "/home/remotepasswd"
    #sftp.get(filepath,localpath)

    # Upload
    #filepath = "/home/foo.jpg"
    #localpath = "/home/pony.jpg"
    #sftp.put(localpath,filepath)

    # Close
    if sftp: sftp.close()
    if transport: transport.close()

if __name__ == "__main__":
    main()